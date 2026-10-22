import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingKey } from '@openadlc/db';
import { imageAttestationCheckArgs, nextRelease, releaseAssets, selfUpdateAttention, type ReleaseImage, type SelfUpdateLast } from '@openadlc/shared';
import type { CloudSelfUpdateRun } from './cloud-update.js';

vi.mock('@openadlc/db', () => ({ audit: vi.fn(), settings: {} }));

const { SelfUpdate } = await import('./self-update.js');
const { CloudUpdate, cloudInstallFrom, cloudStopReason } = await import('./cloud-update.js');

/**
 * Self-update on a Google Cloud install: the same run as a checkout's up to
 * the restart, which is a roll of the console, then hostd, then the bridge,
 * onto a release's checked images. Cloud Run's API, the registry, GitHub,
 * `gh` and hostd are stand-ins, so what is checked is which release is taken,
 * what is checked before anything rolls, the order, and what each stop says.
 */

const REPO = '620legal/OpenADLC';
const PROJECT = 'acme-openadlc';
const REGION = 'europe-west1';
const MIRROR = `${REGION}-docker.pkg.dev/${PROJECT}/openadlc-ghcr`;
const HOSTD = 'http://10.128.0.5:47312';
const SECRET = 'internal-secret-for-the-test';
// Made up, and built here so no credential-shaped literal is in the source.
const GITHUB_TOKEN = ['gho', 'automation-account'].join('_');
const GOOGLE_TOKEN = ['ya29', 'metadata-server'].join('.');
/** A token in the bridge's own environment, which no check may carry. */
const STARTED_WITH = ['ghs', 'bridge-environment'].join('_');
const COMMITS: Record<string, string> = { 'v0.1.0': '1'.repeat(40), 'v0.2.0': '2'.repeat(40), 'v0.3.0': '3'.repeat(40) };

function manifest(image: string, tag: string): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: `${image}-${tag}` } }));
}
const hashOf = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const digest = (image: string, tag: string) => `sha256:${hashOf(manifest(image, tag))}`;
/** The image a release's tag names once someone pushed it again, onto another image. */
const again = (image: string, tag: string) => digest(image, `${tag}+again`);
/** A release's images.json, as publish writes it: the digests its tags named when it was made. */
const recordOf = (tag: string) => `${JSON.stringify({ format: 1, tag, commit: COMMITS[tag], images: { service: digest('service', tag), console: digest('console', tag) } })}\n`;
const mirrorRef = (image: string, tag: string) => `${MIRROR}/620legal/openadlc/${image}@${digest(image, tag)}`;
const TARGET = { service: mirrorRef('service', 'v0.2.0'), console: mirrorRef('console', 'v0.2.0') };

interface Service {
  id: string;
  generation: number;
  observedGeneration: number;
  reconciling: boolean;
  image: string;
  revisions: Map<string, string>;
  latestCreated: string;
  latestReady: string;
  terminal: string;
  message?: string;
  looksLeft: number;
  failNext: boolean;
  patchStatus?: number;
  patched: Record<string, unknown>[];
  /** Each update's `updateMask`. */
  masks: (string | null)[];
}

function service(id: string, image: string): Service {
  const revision = `${id}-00001`;
  return {
    id,
    generation: 1,
    observedGeneration: 1,
    reconciling: false,
    image,
    revisions: new Map([[revision, image]]),
    latestCreated: revision,
    latestReady: revision,
    terminal: 'CONDITION_SUCCEEDED',
    looksLeft: 0,
    failNext: false,
    patched: [],
    masks: [],
  };
}

const made: string[] = [];

class World {
  env: NodeJS.ProcessEnv = {
    OPENADLC_CLOUD: 'gcp',
    OPENADLC_CLOUD_PROJECT: PROJECT,
    OPENADLC_CLOUD_REGION: REGION,
    OPENADLC_CLOUD_BRIDGE_SERVICE: 'openadlc-bridge',
    OPENADLC_CLOUD_CONSOLE_SERVICE: 'openadlc-console',
    OPENADLC_RELEASE_MIRROR: MIRROR,
    OPENADLC_RELEASE_REPO: REPO,
    OPENADLC_SELF_UPDATE: 'on',
    OPENADLC_HOSTD_URL: HOSTD,
    K_REVISION: 'openadlc-bridge-00001',
  };
  home = mkdtempSync(join(tmpdir(), 'cloud-home-'));
  now = new Date('2026-10-21T10:00:00Z');
  settings: Partial<Record<SettingKey, string>> = {};
  audits: { actor: string; action: string; payload?: Record<string, unknown> }[] = [];
  holds: string[] = [];
  released = 0;
  live: { id: string; bot: string; subjectRef: string; kind: string }[] = [];
  /** Every call that changes something, in order, and what the run record said at that moment. */
  events: string[] = [];
  seen: Record<string, { run: CloudSelfUpdateRun | null; consoleServing: boolean; hostOn: string | null }> = {};
  calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string; bundles?: string; configEmpty?: boolean }[] = [];
  /** Each read of GitHub's attestations API: whether it carried a credential. */
  attestationReads: { digest: string; authorization: string | null }[] = [];
  /** Every other request's credential, by where it went. */
  otherAuthorizations: { url: string; authorization: string | null }[] = [];
  /** Digests GitHub keeps no attestation of. */
  unattested = new Set<string>();
  /** GitHub refuses the token on the attestations API, as it does one expired. */
  refuseToken = false;
  /** What `gh` says of a check: refused for an image, or a tag; the run behind the release's attestation. */
  gh: { failImage?: ReleaseImage; failTag?: string; trigger?: string } = {};
  mutable = new Set<string>();
  /** Draft releases listed between the newest two and the one in use, so it falls onto a later page. */
  drafts = 0;
  /** Which pages of releases were asked for. */
  pages: string[] = [];
  /** A run record whose write the store refuses, once. */
  refuseRunWrite: ((value: string) => boolean) | null = null;
  /** Whether the bridge's service had settled each time the last result was written. */
  recordedWhileServing: boolean[] = [];
  registry: { anonymous: boolean[]; wrongDigest?: string } = { anonymous: [] };
  /** Releases that recorded their images' digests: images.json is listed beside their three files. */
  records = new Set<string>();
  /** `<tag>/<image>` whose tag was pushed again since the release, onto another image. */
  retagged = new Set<string>();
  /** Digests the registry no longer serves: versions deleted from the package. */
  deleted = new Set<string>();
  /** A release's images.json as served, in place of the one its SHA256SUMS gives. */
  servedRecord: Record<string, string> = {};
  /** Each manifest asked for by digest, and each release file downloaded. */
  byDigest: string[] = [];
  downloads: string[] = [];
  denyCloudRun = false;
  services: Record<string, Service> = {
    'openadlc-console': service('openadlc-console', mirrorRef('console', 'v0.1.0')),
    'openadlc-bridge': service('openadlc-bridge', mirrorRef('service', 'v0.1.0')),
  };
  hostd = {
    service: mirrorRef('service', 'v0.1.0') as string | null,
    startedAt: '2026-10-21T09:00:00.000Z',
    missing: false,
    postStatus: 0,
    postError: '',
    away: 0,
    pending: null as string | null,
    comesBackOn: null as string | null,
    posted: [] as unknown[],
    busy: [] as string[],
  };

  constructor() {
    made.push(this.home);
  }

  run = (): CloudSelfUpdateRun | null => (this.settings.selfUpdateRun ? (JSON.parse(this.settings.selfUpdateRun) as CloudSelfUpdateRun) : null);
  last = (): SelfUpdateLast | null => (this.settings.selfUpdateLast ? (JSON.parse(this.settings.selfUpdateLast) as SelfUpdateLast) : null);

  private event(name: string): void {
    const console = this.services['openadlc-console']!;
    this.events.push(name);
    this.seen[name] = {
      run: this.run(),
      consoleServing: !console.reconciling && console.latestReady === console.latestCreated && console.image === console.revisions.get(console.latestReady),
      hostOn: this.hostd.service,
    };
  }

  private serviceJson(s: Service): Record<string, unknown> {
    const name = `projects/${PROJECT}/locations/${REGION}/services/${s.id}`;
    return {
      name,
      uid: `uid-${s.id}`,
      generation: String(s.generation),
      observedGeneration: String(s.observedGeneration),
      reconciling: s.reconciling,
      etag: `"etag-${s.generation}"`,
      uri: `https://${s.id}-abc.a.run.app`,
      template: { serviceAccount: `${s.id}@${PROJECT}.iam.gserviceaccount.com`, containers: [{ image: s.image, ports: [{ containerPort: 8080 }] }] },
      traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
      terminalCondition: { type: 'Ready', state: s.terminal, ...(s.message ? { message: s.message } : {}) },
      latestReadyRevision: `${name}/revisions/${s.latestReady}`,
      latestCreatedRevision: `${name}/revisions/${s.latestCreated}`,
      trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
    };
  }

  /**
   * A GET while a revision deploys: a couple of looks later it is ready, or
   * it failed. As Cloud Run v2 has it, a failed reconcile leaves
   * `observedGeneration` on the generation that last served. A failure is
   * once: the revision after it (a put-back, a retry) comes up.
   */
  private look(s: Service): void {
    if (!s.reconciling) return;
    s.looksLeft -= 1;
    if (s.looksLeft > 0) return;
    s.reconciling = false;
    if (s.failNext) {
      s.failNext = false;
      s.terminal = 'CONDITION_FAILED';
      s.message = `Revision '${s.latestCreated}' is not ready and cannot serve traffic. The user-provided container failed to start and listen on the port`;
    } else {
      s.observedGeneration = s.generation;
      s.terminal = 'CONDITION_SUCCEEDED';
      s.message = undefined;
      s.latestReady = s.latestCreated;
    }
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    if (url === 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token') {
      if (headers.get('metadata-flavor') !== 'Google') return new Response('', { status: 403 });
      return Response.json({ access_token: GOOGLE_TOKEN, expires_in: 3599, token_type: 'Bearer' });
    }
    if (!url.includes('/attestations/')) this.otherAuthorizations.push({ url, authorization: headers.get('authorization') });
    const [path, query] = url.split('?') as [string, string | undefined];
    const run = /^https:\/\/run\.googleapis\.com\/v2\/projects\/([^/]+)\/locations\/([^/]+)\/services\/([^/]+)(?:\/revisions\/([^/]+))?$/.exec(path);
    if (run) {
      if (headers.get('authorization') !== `Bearer ${GOOGLE_TOKEN}`) return Response.json({ error: { message: 'no credential' } }, { status: 401 });
      if (this.denyCloudRun) return Response.json({ error: { message: `Permission 'run.services.get' denied` } }, { status: 403 });
      const s = this.services[run[3]!];
      if (run[1] !== PROJECT || run[2] !== REGION || !s) return Response.json({ error: { message: 'not found' } }, { status: 404 });
      if (run[4]) {
        const image = s.revisions.get(run[4]);
        return image ? Response.json({ name: `${run[3]}/revisions/${run[4]}`, containers: [{ image }] }) : Response.json({ error: { message: 'no revision' } }, { status: 404 });
      }
      if (method === 'GET') {
        this.look(s);
        return Response.json(this.serviceJson(s));
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { template: { containers: { image: string }[] } };
        s.patched.push(body);
        s.masks.push(new URLSearchParams(query ?? '').get('updateMask'));
        this.event(`PATCH ${s.id}`);
        if (s.patchStatus) return Response.json({ error: { message: `Permission 'run.services.update' denied on ${s.id}` } }, { status: s.patchStatus });
        if (body.etag !== `"etag-${s.generation}"`) return Response.json({ error: { message: 'etag mismatch' } }, { status: 409 });
        // Without the mask the update is the whole service sent; the bridge narrows it.
        if (new URLSearchParams(query ?? '').get('updateMask') !== 'template') return Response.json({ error: { message: 'the update names no field mask' } }, { status: 400 });
        s.generation += 1;
        s.image = body.template.containers[0]!.image;
        s.latestCreated = `${s.id}-0000${s.generation}`;
        s.revisions.set(s.latestCreated, s.image);
        s.reconciling = true;
        s.terminal = 'CONDITION_RECONCILING';
        s.looksLeft = 2;
        return Response.json({ name: `projects/${PROJECT}/locations/${REGION}/operations/op-${s.generation}`, done: false });
      }
    }
    if (url.startsWith('https://ghcr.io/token?')) {
      this.registry.anonymous.push(!headers.has('authorization'));
      return Response.json({ token: 'anonymous-pull' });
    }
    const pulled = /^https:\/\/ghcr\.io\/v2\/620legal\/openadlc\/(service|console)\/manifests\/(v[0-9.]+|sha256:[0-9a-f]{64})$/.exec(url);
    if (pulled) {
      if (headers.get('authorization') !== 'Bearer anonymous-pull') return new Response('', { status: 401 });
      const [, image, reference] = pulled as unknown as [string, string, string];
      let body: Buffer | undefined;
      if (reference.startsWith('sha256:')) {
        this.byDigest.push(reference);
        const known = Object.keys(COMMITS).flatMap((tag) => [manifest(image, tag), manifest(image, `${tag}+again`)]);
        body = this.deleted.has(reference) ? undefined : known.find((one) => `sha256:${hashOf(one)}` === reference);
      } else if (COMMITS[reference]) {
        body = manifest(image, this.retagged.has(`${reference}/${image}`) ? `${reference}+again` : reference);
      }
      if (!body) return new Response('', { status: 404 });
      return new Response(body, {
        headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json', 'docker-content-digest': this.registry.wrongDigest ?? `sha256:${hashOf(body)}` },
      });
    }
    const download = new RegExp(`^https://github\\.com/${REPO}/releases/download/(v[0-9.]+)/(SHA256SUMS|images\\.json)$`).exec(url);
    if (download && this.records.has(download[1]!)) {
      const [, tag, name] = download as unknown as [string, string, string];
      this.downloads.push(`${tag}/${name}`);
      if (name === 'images.json') return new Response(this.servedRecord[tag] ?? recordOf(tag));
      return new Response(`${'f'.repeat(64)}  openadlc-${tag}.tar.gz\n${hashOf(recordOf(tag))}  images.json\n`);
    }
    const attestations = new RegExp(`^https://api\\.github\\.com/repos/${REPO}/attestations/(sha256%3A[0-9a-f]{64})$`).exec(url);
    if (attestations) {
      const asked = decodeURIComponent(attestations[1]!);
      this.attestationReads.push({ digest: asked, authorization: headers.get('authorization') });
      if (this.refuseToken && headers.has('authorization')) return Response.json({ message: 'Bad credentials' }, { status: 401 });
      if (this.unattested.has(asked)) return Response.json({ message: 'Not Found' }, { status: 404 });
      // Two bundles, as GitHub keeps one per attestation; gh picks by predicate.
      return Response.json({ attestations: [{ bundle: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', subject: asked } }, { bundle: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', other: true } }] });
    }
    if (url === `https://api.github.com/repos/${REPO}`) return Response.json({ full_name: REPO });
    const listing = new RegExp(`^https://api\\.github\\.com/repos/${REPO}/releases\\?per_page=30(?:&page=(\\d+))?$`).exec(url);
    if (listing) {
      const page = Number(listing[1] ?? '1');
      this.pages.push(String(page));
      const release = (tag: string, draft = false) => ({
        tag_name: tag,
        draft,
        prerelease: false,
        immutable: !this.mutable.has(tag),
        published_at: '2026-10-18T12:00:00Z',
        assets: [...Object.values(releaseAssets(tag)), ...(this.records.has(tag) ? ['images.json'] : [])].map((name) => ({ name })),
      });
      const [newest, ...older] = Object.keys(COMMITS).reverse();
      const all = [release(newest!), ...older.slice(0, -1).map((tag) => release(tag)), ...Array.from({ length: this.drafts }, (_, n) => release(`v9.${n}.0`, true)), release(older.at(-1)!)];
      return Response.json(all.slice((page - 1) * 30, page * 30));
    }
    const commit = new RegExp(`^https://api\\.github\\.com/repos/${REPO}/commits/(v[0-9.]+)$`).exec(url);
    if (commit && COMMITS[commit[1]!]) return Response.json({ sha: COMMITS[commit[1]!], commit: { committer: { date: '2026-10-17T08:00:00Z' } } });
    if (url === `${HOSTD}/internal/restart-onto-image`) {
      if (headers.get('x-openadlc-internal-secret') !== SECRET) return Response.json({ error: 'needs the secret' }, { status: 401 });
      if (this.hostd.missing) return Response.json({ error: `no route for ${method} /internal/restart-onto-image` }, { status: 404 });
      if (method === 'GET') {
        if (this.hostd.away > 0) {
          this.hostd.away -= 1;
          if (this.hostd.away === 0 && this.hostd.pending) {
            this.hostd.service = this.hostd.comesBackOn ?? this.hostd.pending;
            this.hostd.startedAt = '2026-10-21T10:05:00.000Z';
            this.hostd.pending = null;
          }
          throw new TypeError('fetch failed');
        }
        return Response.json({ service: this.hostd.service, startedAt: this.hostd.startedAt, busy: this.hostd.busy });
      }
      this.event('POST hostd');
      const body = JSON.parse(String(init?.body)) as { service: string };
      this.hostd.posted.push(body);
      if (this.hostd.postStatus) return Response.json({ error: this.hostd.postError }, { status: this.hostd.postStatus });
      this.hostd.pending = body.service;
      this.hostd.away = 2;
      return Response.json({ restarting: true, service: body.service }, { status: 202 });
    }
    return new Response(`no stand-in for ${method} ${url}`, { status: 599 });
  }) as typeof fetch;

  runCommand = async (command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string> => {
    const bundle = args.includes('--bundle') ? args[args.indexOf('--bundle') + 1] : undefined;
    const config = options.env?.GH_CONFIG_DIR;
    this.calls.push({
      command,
      args: [...args],
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      // What gh is given, as it is while gh runs.
      ...(bundle && existsSync(bundle) ? { bundles: readFileSync(bundle, 'utf8') } : {}),
      ...(config ? { configEmpty: existsSync(config) && readdirSync(config).length === 0 } : {}),
    });
    // A cloud bridge runs from an image, with no checkout to run git in.
    if (command !== 'gh') throw new Error(`${command} is not in this stand-in`);
    if (args.includes('--help')) return '--bundle --cert-identity --source-ref --source-digest --deny-self-hosted-runners';
    const image = /openadlc\/(service|console)@/.exec(args[2] ?? '')?.[1];
    const tag = (args[args.indexOf('--source-ref') + 1] ?? '').replace('refs/tags/', '');
    if (image === this.gh.failImage || tag === this.gh.failTag) throw new Error('gh attestation verify exited 1: no attestations matched the policy');
    // The trigger is the next release's: the one in use checks out.
    const trigger = tag === 'v0.2.0' ? (this.gh.trigger ?? 'push') : 'push';
    return JSON.stringify([{ verificationResult: { signature: { certificate: { buildTrigger: trigger, buildConfigURI: `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/${tag}` } } } }]);
  };

  /** The bridge, as main.ts makes it, with the cloud backend made here so its waits are short; `fromEnv` makes it from the environment instead. */
  updater(options: { env?: NodeJS.ProcessEnv; fromEnv?: boolean } = {}): InstanceType<typeof SelfUpdate> {
    const env = options.env ?? this.env;
    const found = cloudInstallFrom(env);
    const cloud = found
      ? new CloudUpdate({
          install: found.install,
          missing: found.missing,
          fetch: this.fetch,
          run: this.runCommand,
          workRoot: join(this.home, 'self-update'),
          hostdSecret: async () => SECRET,
          githubToken: async () => GITHUB_TOKEN,
          pollMs: 1,
          rollMaxMs: 3_000,
          hostMaxMs: 3_000,
          log: () => undefined,
        })
      : null;
    return new SelfUpdate({
      repoRoot: join(this.home, 'no-checkout-here'),
      home: this.home,
      timeZone: 'UTC',
      pollMs: 1,
      resultPollMs: 1,
      now: () => this.now,
      run: this.runCommand,
      fetch: this.fetch,
      token: async () => GITHUB_TOKEN,
      env,
      ...(options.fromEnv ? {} : { cloud }),
      store: {
        all: async () => ({ ...this.settings }),
        set: async (key, value) => {
          if (key === 'selfUpdateLast') {
            const bridge = this.services['openadlc-bridge']!;
            this.recordedWhileServing.push(!bridge.reconciling && bridge.latestReady === bridge.latestCreated);
          }
          if (key === 'selfUpdateRun' && this.refuseRunWrite?.(value)) {
            this.refuseRunWrite = null;
            throw new Error('the database went away');
          }
          if (value === '') delete this.settings[key];
          else this.settings[key] = value;
        },
      },
      audit: async (entry) => {
        this.audits.push(entry);
      },
      liveTasks: async () => [...this.live],
      engineUpdateRunning: async () => false,
      gate: {
        hold: (reason) => {
          this.holds.push(reason);
          return () => {
            this.released += 1;
          };
        },
      },
      spawnApply: () => {
        throw new Error('a cloud install starts no restart process');
      },
      isAlive: () => false,
      log: () => undefined,
    });
  }
}

async function until(what: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

let world: World;
beforeEach(() => {
  world = new World();
  vi.stubEnv('GITHUB_TOKEN', STARTED_WITH);
  vi.stubEnv('GH_TOKEN', STARTED_WITH);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('which way an install updates', () => {
  it('rolls images on a cloud install, which is not a checkout and is not refused for it', async () => {
    const view = await world.updater({ fromEnv: true }).view();
    expect(view.backend).toBe('cloud');
    expect(view.repository).toBe(REPO);
    expect(view.applicable).toBe(true);
    expect(view.reason).toBe('');
    expect(view.inUse).toEqual({ sha: COMMITS['v0.1.0'], date: '2026-10-17T08:00:00Z', tag: 'v0.1.0' });
    expect(world.calls.filter((call) => call.command === 'git')).toEqual([]);

    // The same bridge without the module's word is a checkout install, and
    // this is no checkout.
    const checkout = await world.updater({ env: {}, fromEnv: true }).view();
    expect(checkout.backend).toBe('checkout');
    expect(checkout.applicable).toBe(false);
    expect(checkout.reason).toMatch(/is not a git checkout/);
  });

  it('reads what the module set, and names what it did not', () => {
    expect(cloudInstallFrom({})).toBeNull();
    expect(cloudInstallFrom({ OPENADLC_CLOUD: 'aws' })).toBeNull();
    const found = cloudInstallFrom({ OPENADLC_CLOUD: 'gcp', OPENADLC_CLOUD_PROJECT: PROJECT, OPENADLC_SELF_UPDATE: 'on' })!;
    expect(found.install).toMatchObject({ project: PROJECT, repo: REPO, selfUpdate: true });
    expect(found.missing).toEqual(['OPENADLC_CLOUD_REGION', 'OPENADLC_CLOUD_BRIDGE_SERVICE', 'OPENADLC_CLOUD_CONSOLE_SERVICE', 'OPENADLC_RELEASE_MIRROR']);
    expect(cloudInstallFrom({ ...world.env, OPENADLC_SELF_UPDATE: 'off' })!.install.selfUpdate).toBe(false);
  });

  it('finds the release in use a page or more down the list, and reads no further', async () => {
    // v0.3.0 and v0.2.0, then 28 drafts: v0.1.0 is the first of page 2.
    world.drafts = 28;
    const update = world.updater();
    expect((await update.view()).inUse).toMatchObject({ tag: 'v0.1.0' });
    expect(await update.refreshCandidate(true)).toMatchObject({ tag: 'v0.2.0' });
    expect([...new Set(world.pages)]).toEqual(['1', '2']);
  });

  it('says why when the bridge runs no release’s image', async () => {
    world.services['openadlc-bridge']!.image = `${REGION}-docker.pkg.dev/${PROJECT}/openadlc/service:4f2a9c1`;
    world.services['openadlc-bridge']!.revisions.set('openadlc-bridge-00001', world.services['openadlc-bridge']!.image);
    const view = await world.updater().view();
    expect(view.applicable).toBe(false);
    expect(view.inUse).toBeNull();
    expect(view.reason).toMatch(/not a release's image by its digest.*openadlc cloud update --release/);
  });
});

describe('the release a cloud install takes', () => {
  const release = (tag: string) => ({ tag, draft: false, prerelease: false, publishedAt: null, assets: [], immutable: true });

  it('is the next after the one in use, never a later one', () => {
    const takeable = [release('v0.3.0'), release('v0.2.0'), release('v0.1.0')];
    expect(nextRelease(takeable, 'v0.1.0')).toEqual({ next: release('v0.2.0'), newest: release('v0.3.0') });
    expect(nextRelease(takeable, 'v0.2.0')).toEqual({ next: release('v0.3.0'), newest: release('v0.3.0') });
    expect(nextRelease(takeable, 'v0.3.0')).toEqual({ next: null, newest: null });
    // By version, not by the order GitHub lists them in.
    expect(nextRelease([release('v0.10.0'), release('v0.9.1'), release('v0.9.0')], 'v0.9.0').next?.tag).toBe('v0.9.1');
  });

  it('says so on the row when the newest is further ahead, and takes the next', async () => {
    const update = world.updater();
    const candidate = await update.refreshCandidate(true);
    expect(candidate).toMatchObject({ tag: 'v0.2.0', sha: COMMITS['v0.2.0'], newest: 'v0.3.0' });
    expect(candidate?.reason).toBe('takes the next release, v0.2.0, not v0.3.0: a cloud install takes one release at a time, since its bridge and its host each migrate the database as they start');
    expect((await update.view()).candidate).toMatchObject({ tag: 'v0.2.0', newest: 'v0.3.0' });

    world.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.run()?.phase === 'waiting');
    expect(world.run()).toMatchObject({ tag: 'v0.2.0', from: COMMITS['v0.1.0'], to: COMMITS['v0.2.0'] });
    expect(world.calls.filter((call) => call.args.includes('refs/tags/v0.2.0'))).toHaveLength(2);
    expect(world.calls.filter((call) => call.args.includes('refs/tags/v0.3.0'))).toEqual([]);
  });

  it('stops at a next release it cannot take, and takes no later one', async () => {
    world.mutable.add('v0.2.0');
    const update = world.updater();
    const candidate = await update.refreshCandidate(true);
    expect(candidate).toMatchObject({ tag: null });
    expect(candidate?.reason).toMatch(/^the next release, v0\.2\.0, is not an immutable release.*so it stays on v0\.1\.0 and takes no later one: roll it past v0\.2\.0 by hand/);
    await update.start({ trigger: 'schedule', actor: 'schedule' });
    expect(world.last()).toMatchObject({ state: 'failed', step: 'releases', tag: 'v0.2.0' });
    expect(world.calls.filter((call) => call.args.includes('refs/tags/v0.3.0'))).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it('knows the release in use only once the image the bridge runs checks out as that release’s', async () => {
    world.gh.failTag = 'v0.1.0';
    const view = await world.updater().view();
    expect(view.inUse).toBeNull();
    expect(view.applicable).toBe(false);
    expect(view.reason).toMatch(/^the registry names the bridge's image v0\.1\.0's, but gh attestation verify refused .*service@sha256:.*so which release it runs is not known/);
  });

  it('is nothing once on the newest', async () => {
    world.services['openadlc-bridge']!.image = mirrorRef('service', 'v0.3.0');
    world.services['openadlc-bridge']!.revisions.set('openadlc-bridge-00001', mirrorRef('service', 'v0.3.0'));
    const update = world.updater();
    expect(await update.refreshCandidate(true)).toMatchObject({ tag: null, reason: 'on v0.3.0, the newest release' });
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    expect(world.last()).toMatchObject({ state: 'current', reason: 'on v0.3.0, the newest release' });
    expect(world.events).toEqual([]);
  });
});

describe('checking the images', () => {
  it('resolves each tag at the registry without a login, and checks each digest as the archive is checked', async () => {
    world.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.run()?.phase === 'waiting');

    const checks = world.calls.filter((call) => call.command === 'gh' && call.args.includes('refs/tags/v0.2.0'));
    expect(checks.map((call) => call.args)).toEqual(
      (['service', 'console'] as const).map((image, index) => [
        ...imageAttestationCheckArgs({ repo: REPO, image, digest: digest(image, 'v0.2.0'), tag: 'v0.2.0', commit: COMMITS['v0.2.0']!, bundle: checks[index]!.args[checks[index]!.args.indexOf('--bundle') + 1]! }),
        '--format',
        'json',
      ]),
    );
    for (const [index, call] of checks.entries()) {
      const image = (['service', 'console'] as const)[index]!;
      // The bundles GitHub's attestations API gave, read with no credential,
      // one per line, in a file of the run's own that is gone after.
      const bundle = call.args[call.args.indexOf('--bundle') + 1]!;
      expect(bundle.startsWith(join(world.home, 'self-update', 'v0.2.0', 'attestations-'))).toBe(true);
      expect(call.cwd).toBe(join(bundle, '..'));
      expect(call.bundles?.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
        { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', subject: digest(image, 'v0.2.0') },
        { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', other: true },
      ]);
      expect(existsSync(bundle)).toBe(false);
      // No GitHub credential at all: not the automation account's, nor any the
      // bridge was started with, and no sign-in of the machine's.
      expect(call.env?.GH_TOKEN).toBeUndefined();
      expect(call.env?.GITHUB_TOKEN).toBeUndefined();
      expect(Object.values(call.env ?? {})).not.toContain(GITHUB_TOKEN);
      expect(Object.values(call.env ?? {})).not.toContain(STARTED_WITH);
      expect(call.configEmpty).toBe(true);
    }
    expect(world.attestationReads.filter((read) => read.digest.endsWith(digest('service', 'v0.2.0').slice(7)) || read.digest === digest('console', 'v0.2.0'))).toHaveLength(2);
    // The bridge's own GitHub token on the attestations request, which Cloud
    // Run's shared addresses would otherwise make share a limit of 60 an hour;
    // on no other request, and never to gh.
    expect(world.attestationReads.every((read) => read.authorization === `Bearer ${GITHUB_TOKEN}`)).toBe(true);
    // GitHub's API is where the bridge already reads releases with it; the registry, Cloud Run and hostd never see it.
    expect(world.otherAuthorizations.filter((one) => one.authorization?.includes(GITHUB_TOKEN) && !one.url.startsWith('https://api.github.com/'))).toEqual([]);
    expect(world.otherAuthorizations.filter((one) => one.url.startsWith('https://ghcr.io/')).every((one) => one.authorization === null || one.authorization === 'Bearer anonymous-pull')).toBe(true);
    expect(existsSync(join(world.home, 'self-update', 'v0.2.0'))).toBe(false);
    expect(world.registry.anonymous.length).toBeGreaterThan(0);
    expect(world.registry.anonymous.every(Boolean)).toBe(true);
    // The digests, in the install's mirror, are what will roll; while tasks run nothing has.
    expect(world.run()?.cloud?.target).toEqual(TARGET);
    expect(world.events).toEqual([]);
  });

  it('rolls nothing unless both check out', async () => {
    world.gh.failImage = 'console';
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'images', from: COMMITS['v0.1.0'], to: COMMITS['v0.1.0'], tag: 'v0.2.0' });
    expect(world.last()?.reason).toMatch(/^gh attestation verify refused ghcr\.io\/620legal\/openadlc\/console@sha256:/);
    expect(world.last()?.reason).toMatch(/stays on v0\.1\.0 until v0\.2\.0 checks out.*The install is as it was$/);
    expect(world.events).toEqual([]);
    expect(world.holds).toEqual([]);
  });

  it('asks the attestations API without the token when GitHub refuses it', async () => {
    world.refuseToken = true;
    world.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.run()?.phase === 'waiting');
    expect(world.run()?.cloud?.target).toEqual(TARGET);
    expect(world.attestationReads.map((read) => read.authorization)).toContain(null);
  });

  it('refuses an image GitHub keeps no attestation of, without running gh on it', async () => {
    world.unattested.add(digest('console', 'v0.2.0'));
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'images' });
    expect(world.last()?.reason).toMatch(/^GitHub has no attestation of ghcr\.io\/620legal\/openadlc\/console@sha256:/);
    expect(world.calls.filter((call) => call.args[2]?.includes('/console@'))).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it('refuses an attestation whose run was not the tag’s push by release.yml', async () => {
    world.gh.trigger = 'workflow_dispatch';
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'images' });
    expect(world.last()?.reason).toMatch(/started by workflow_dispatch, not by the push of v0\.2\.0/);
    expect(world.events).toEqual([]);
  });

  it('takes a digest from the manifest’s own bytes, and refuses a registry that says otherwise', async () => {
    const update = world.updater();
    expect((await update.view()).inUse?.tag).toBe('v0.1.0');
    world.registry.wrongDigest = `sha256:${'e'.repeat(64)}`;
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'images' });
    expect(world.last()?.reason).toMatch(/the registry says ghcr\.io\/620legal\/openadlc\/console:v0\.2\.0 is sha256:e{64}, and its manifest is sha256:/);
    expect(world.events).toEqual([]);
  });
});

describe('a release that recorded its images’ digests', () => {
  // v0.1.0, which the install runs, is from before releases recorded them; v0.2.0 is after.
  beforeEach(() => {
    world.records.add('v0.2.0');
  });
  const task = { id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' };

  it('is taken by the digests it recorded, whatever its tags name now, and a tag pushed again is said, naming both digests', async () => {
    world.retagged.add('v0.2.0/console');
    // Pushed again by someone who can write the packages, with nothing to attest it: taken by its tag,
    // the release would have been refused on every install.
    world.unattested.add(again('console', 'v0.2.0'));
    world.live = [task];
    const update = world.updater();
    const words = `ghcr.io/620legal/openadlc/console:v0.2.0 names ${again('console', 'v0.2.0')} now, not ${digest('console', 'v0.2.0')}, the digest v0.2.0 recorded`;
    // The row says so before any run: it is the release a run would take.
    await update.refreshCandidate(true);
    expect((await update.view()).movedTags).toEqual([expect.stringContaining(words)]);

    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.run()?.phase === 'waiting');
    expect(world.run()?.cloud?.target).toEqual(TARGET);
    expect(world.run()?.cloud?.moved).toEqual([{ tag: 'v0.2.0', image: 'console', recorded: digest('console', 'v0.2.0'), now: again('console', 'v0.2.0') }]);
    // Each checked by its recorded digest, which the registry still serves; the image the tag names now is never checked.
    const checked = world.calls.filter((call) => call.command === 'gh' && call.args.includes('refs/tags/v0.2.0')).map((call) => call.args[2]);
    expect(checked).toEqual([`oci://ghcr.io/620legal/openadlc/service@${digest('service', 'v0.2.0')}`, `oci://ghcr.io/620legal/openadlc/console@${digest('console', 'v0.2.0')}`]);
    expect(world.byDigest).toEqual(expect.arrayContaining([digest('service', 'v0.2.0'), digest('console', 'v0.2.0')]));
    expect(world.attestationReads.map((read) => read.digest)).not.toContain(again('console', 'v0.2.0'));
    // The record is the release's own files, read once and with no credential.
    expect(world.downloads).toEqual(['v0.2.0/SHA256SUMS', 'v0.2.0/images.json']);
    expect(world.otherAuthorizations.filter((one) => one.url.startsWith('https://github.com/')).map((one) => one.authorization)).toEqual([null, null]);
    // In the audit log, and still on the row, once, while the run waits.
    expect(world.audits.filter((entry) => entry.action === 'openadlc.release_tag_moved')).toEqual([
      expect.objectContaining({ actor: 'openadlc', payload: { tag: 'v0.2.0', image: 'console', recorded: digest('console', 'v0.2.0'), now: again('console', 'v0.2.0') } }),
    ]);
    expect((await update.view()).movedTags).toEqual([expect.stringContaining(words)]);
  });

  it('is found as the release in use by the digest it recorded, with its tag pushed again since', async () => {
    world.records.add('v0.1.0');
    world.retagged.add('v0.1.0/service');
    const update = world.updater();
    expect((await update.view()).inUse).toMatchObject({ tag: 'v0.1.0', sha: COMMITS['v0.1.0'] });
    expect(await update.refreshCandidate(true)).toMatchObject({ tag: 'v0.2.0' });
    expect((await update.view()).movedTags).toEqual([expect.stringContaining(`ghcr.io/620legal/openadlc/service:v0.1.0 names ${again('service', 'v0.1.0')} now, not ${digest('service', 'v0.1.0')}`)]);
  });

  it('says nothing of tags that still name what it recorded', async () => {
    world.live = [task];
    const update = world.updater();
    await update.refreshCandidate(true);
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.run()?.phase === 'waiting');
    expect(world.run()?.cloud?.target).toEqual(TARGET);
    expect(world.run()?.cloud?.moved).toBeUndefined();
    expect((await update.view()).movedTags).toEqual([]);
    expect(world.audits.filter((entry) => entry.action === 'openadlc.release_tag_moved')).toEqual([]);
  });

  it('rolls nothing when a digest it recorded is no longer served, rather than take what the tag names', async () => {
    world.retagged.add('v0.2.0/console');
    world.deleted.add(digest('console', 'v0.2.0'));
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'images', tag: 'v0.2.0', to: COMMITS['v0.1.0'] });
    expect(world.last()?.reason).toMatch(
      /^ghcr\.io\/620legal\/openadlc\/console@sha256:[0-9a-f]{64}, the console image v0\.2\.0 recorded, cannot be pulled: .*is not at the registry \(404\), so nothing is rolled; .*The install is as it was$/,
    );
    expect(world.calls.filter((call) => call.args[2]?.includes(again('console', 'v0.2.0')))).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it('rolls nothing when its images.json is not the one its SHA256SUMS gives', async () => {
    world.servedRecord['v0.2.0'] = recordOf('v0.2.0').replace(digest('console', 'v0.2.0'), again('console', 'v0.2.0'));
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'images', tag: 'v0.2.0' });
    expect(world.last()?.reason).toMatch(/^could not read the digests v0\.2\.0 recorded of its images: v0\.2\.0's images\.json has SHA-256 [0-9a-f]{64}, and SHA256SUMS says/);
    expect(world.calls.filter((call) => call.args.includes('refs/tags/v0.2.0'))).toEqual([]);
    expect(world.events).toEqual([]);
  });
});

describe('the roll', () => {
  it('updates the console, then hostd, then the bridge, each once the one before is on the release', async () => {
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.events.length === 3);
    expect(world.events).toEqual(['PATCH openadlc-console', 'POST hostd', 'PATCH openadlc-bridge']);
    expect(world.seen['POST hostd']?.consoleServing).toBe(true);
    expect(world.seen['PATCH openadlc-bridge']?.hostOn).toBe(TARGET.service);
    // The record is written before the bridge's own update, which replaces this instance.
    expect(world.seen['PATCH openadlc-bridge']?.run).toMatchObject({ phase: 'restarting', cloud: { step: 'bridge', rolled: ['console', 'host'], target: TARGET } });
    expect(world.seen['PATCH openadlc-bridge']?.run?.cloud?.previous).toEqual({
      console: mirrorRef('console', 'v0.1.0'),
      bridge: mirrorRef('service', 'v0.1.0'),
      service: mirrorRef('service', 'v0.1.0'),
    });
    // hostd is asked for its own image only: the bots' is the host's, which the engine update keeps.
    expect(world.hostd.posted).toEqual([{ service: TARGET.service }]);

    // Only the image changed, and the update carried the etag it read.
    const sent = world.services['openadlc-console']!.patched[0]!;
    expect((sent.template as { containers: { image: string }[] }).containers[0]!.image).toBe(TARGET.console);
    expect((sent.template as { serviceAccount: string }).serviceAccount).toBe(`openadlc-console@${PROJECT}.iam.gserviceaccount.com`);
    expect(sent.etag).toBe('"etag-1"');
    expect(sent.generation).toBeUndefined();
    // Only the revision template is part of the update: not invokerIamDisabled, which takes setIamPolicy to change.
    expect(world.services['openadlc-console']!.masks).toEqual(['template']);
    expect(world.services['openadlc-bridge']!.masks).toEqual(['template']);
    expect(world.services['openadlc-bridge']!.patched[0]!.template).toMatchObject({ containers: [{ image: TARGET.service }] });

    // This bridge holds new work until it is gone, and leaves the record to the bridge on the release.
    await until(() => !world.services['openadlc-bridge']!.reconciling);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.holds).toHaveLength(1);
    expect(world.released).toBe(0);
    expect(world.last()).toBeNull();
    expect(world.run()?.cloud?.generation).toBe(2);
  });

  it('changes nothing when hostd says a task runs on the host', async () => {
    world.hostd.busy = ['task-7'];
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'console', to: COMMITS['v0.1.0'] });
    expect(world.last()?.reason).toMatch(/^before anything was rolled, hostd says a task runs on the host \(task-7\).*The install is as it was$/);
    expect(world.events).toEqual([]);
  });

  it('rolls a fresh install, whose host runs the module’s hostd_image by tag', async () => {
    world.hostd.service = `${REGION}-docker.pkg.dev/${PROJECT}/openadlc/service:v0.1.0`;
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.events.length === 3);
    expect(world.events).toEqual(['PATCH openadlc-console', 'POST hostd', 'PATCH openadlc-bridge']);
    expect(world.run()?.cloud?.previous?.service).toBe(`${REGION}-docker.pkg.dev/${PROJECT}/openadlc/service:v0.1.0`);
  });

  it('takes a release after a roll of it failed once: the failed service was put back, so the retry is a real update', async () => {
    world.services['openadlc-console']!.failNext = true;
    const update = world.updater();
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'console' });
    world.now = new Date('2026-10-21T11:00:00Z');
    await update.start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.events.length === 5);
    expect(world.events).toEqual(['PATCH openadlc-console', 'PATCH openadlc-console', 'PATCH openadlc-console', 'POST hostd', 'PATCH openadlc-bridge']);
    expect(world.services['openadlc-console']!.image).toBe(TARGET.console);
  });

  it('follows its own replacement when the step’s second write is refused, so a failure is still recorded', async () => {
    world.services['openadlc-bridge']!.failNext = true;
    world.refuseRunWrite = (value) => value.includes('"generation"');
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'bridge' });
    expect(world.released).toBe(1);
  });

  it('changes nothing when what runs cannot be read first', async () => {
    world.hostd.missing = true;
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'console', to: COMMITS['v0.1.0'] });
    expect(world.last()?.reason).toMatch(/hostd here has no restart-onto-image.*openadlc cloud update --release/);
    expect(world.events).toEqual([]);
    expect(world.released).toBe(1);
  });

  it('stops at the console as soon as its new revision fails, puts it back, and says nothing rolled', async () => {
    world.services['openadlc-console']!.failNext = true;
    const began = Date.now();
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    // Read from the Ready condition, not waited out: observedGeneration stays on the revision that served.
    expect(Date.now() - began).toBeLessThan(1_500);
    expect(world.events).toEqual(['PATCH openadlc-console', 'PATCH openadlc-console']);
    expect(world.services['openadlc-console']!.patched.map((body) => (body.template as { containers: { image: string }[] }).containers[0]!.image)).toEqual([
      TARGET.console,
      mirrorRef('console', 'v0.1.0'),
    ]);
    expect(world.services['openadlc-console']!.image).toBe(mirrorRef('console', 'v0.1.0'));
    expect(world.last()).toMatchObject({ state: 'failed', step: 'console', from: COMMITS['v0.1.0'], to: COMMITS['v0.1.0'] });
    expect(world.last()?.reason).toMatch(
      /failed to start and listen on the port.*; the console's service is back on .*console@sha256:.*\. Nothing was rolled: the console, the host and the bridge are still on v0\.1\.0\. The install is as it was$/,
    );
    expect(selfUpdateAttention(world.last())?.title).toBe('OpenADLC did not update to v0.2.0 — it is still on the version it had');
    expect(world.released).toBe(1);
    expect(world.run()).toBeNull();
  });

  it('stops at the host with the console on the release, saying what finishes it and what goes back', async () => {
    world.hostd.postStatus = 409;
    world.hostd.postError = 'a task is running here (task-9), and a restart would end it';
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.events).toEqual(['PATCH openadlc-console', 'POST hostd']);
    const last = world.last()!;
    expect(last).toMatchObject({ state: 'failed', step: 'host', from: COMMITS['v0.1.0'], to: COMMITS['v0.2.0'], tag: 'v0.2.0' });
    expect(last.reason).toContain('hostd refused to restart onto');
    expect(last.reason).toContain(`The console runs v0.2.0 (the console on ${TARGET.console}); the host and the bridge are still on v0.1.0.`);
    expect(last.reason).toContain('To finish: openadlc cloud update --release v0.2.0.');
    expect(last.reason).toContain(`gcloud run services update openadlc-console --project ${PROJECT} --region ${REGION} --image ${mirrorRef('console', 'v0.1.0')}`);
    expect(selfUpdateAttention(last)?.title).toBe('The OpenADLC update to v0.2.0 did not finish');
    expect(world.released).toBe(1);
  });

  it('stops at the host when hostd comes back on anything but the release', async () => {
    world.hostd.comesBackOn = mirrorRef('service', 'v0.1.0');
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.events).toEqual(['PATCH openadlc-console', 'POST hostd']);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'host' });
    expect(world.last()?.reason).toMatch(/hostd came back on .*service@sha256:.*the host's fleet-hostd unit passed the file over/);
  });

  it('stops at the bridge with the console and the host on the release', async () => {
    world.services['openadlc-bridge']!.patchStatus = 403;
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.events).toEqual(['PATCH openadlc-console', 'POST hostd', 'PATCH openadlc-bridge']);
    const last = world.last()!;
    expect(last).toMatchObject({ state: 'failed', step: 'bridge', to: COMMITS['v0.2.0'] });
    expect(last.reason).toMatch(/^Cloud Run answered 403 .*only with self_update on/);
    expect(last.reason).toContain('The console and the host run v0.2.0');
    expect(last.reason).toContain('the bridge is still on v0.1.0.');
    expect(last.reason).toContain(
      `the host onto ${mirrorRef('service', 'v0.1.0')} (on the host: sudo sh -c 'echo ${mirrorRef('service', 'v0.1.0')} > /var/lib/fleet/hostd-image' && sudo systemctl restart fleet-hostd)`,
    );
  });

  it('stops at the bridge when its new revision does not become ready, recorded by the bridge that still serves', async () => {
    world.services['openadlc-bridge']!.failNext = true;
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'bridge', to: COMMITS['v0.2.0'] });
    expect(world.last()?.reason).toMatch(/the bridge's new revision did not become ready/);
    expect(world.released).toBe(1);
  });
});

describe('the bridge that comes up on the release', () => {
  it('finishes the record and the audit from the record and the image it runs', async () => {
    await world.updater().start({ trigger: 'console', actor: 'jane@example.com' });
    await until(() => world.events.length === 3 && !world.services['openadlc-bridge']!.reconciling);
    expect(world.last()).toBeNull();

    // Cloud Run starts the new revision, and its bridge reads the record.
    const next = world.updater({ env: { ...world.env, K_REVISION: world.services['openadlc-bridge']!.latestCreated } });
    expect(await next.resume()).toEqual(['this bridge runs v0.2.0, and records the update once its revision serves']);
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'updated', trigger: 'console', actor: 'jane@example.com', from: COMMITS['v0.1.0'], to: COMMITS['v0.2.0'], tag: 'v0.2.0' });
    expect(world.last()?.reason).toBe(`the console, the host and the bridge run v0.2.0: the bridge and hostd on ${TARGET.service}, the console on ${TARGET.console}`);
    expect(world.run()).toBeNull();
    expect(world.audits.filter((entry) => entry.action === 'openadlc.updated')).toEqual([
      expect.objectContaining({ actor: 'jane@example.com', payload: expect.objectContaining({ from: COMMITS['v0.1.0'], to: COMMITS['v0.2.0'], tag: 'v0.2.0', outcome: 'updated' }) }),
    ]);
    expect((await next.view()).inUse).toMatchObject({ tag: 'v0.2.0' });
  });

  it('records the update only once its own revision serves', async () => {
    const bridge = world.services['openadlc-bridge']!;
    world.services['openadlc-console']!.image = TARGET.console;
    world.hostd.service = TARGET.service;
    // Cloud Run starts the new revision's instance before the revision is ready.
    bridge.generation = 2;
    bridge.image = TARGET.service;
    bridge.latestCreated = 'openadlc-bridge-00002';
    bridge.revisions.set('openadlc-bridge-00002', TARGET.service);
    bridge.reconciling = true;
    bridge.terminal = 'CONDITION_RECONCILING';
    bridge.looksLeft = 4;
    world.settings.selfUpdateRun = JSON.stringify({
      phase: 'restarting',
      tag: 'v0.2.0',
      from: COMMITS['v0.1.0']!,
      to: COMMITS['v0.2.0']!,
      trigger: 'console',
      actor: 'jane@example.com',
      startedAt: '2026-10-21T10:00:00.000Z',
      pid: null,
      cloud: { fromTag: 'v0.1.0', step: 'bridge', target: TARGET, previous: { console: mirrorRef('console', 'v0.1.0'), bridge: mirrorRef('service', 'v0.1.0'), service: mirrorRef('service', 'v0.1.0') }, rolled: ['console', 'host'], generation: 2 },
    } satisfies CloudSelfUpdateRun);
    const next = world.updater({ env: { ...world.env, K_REVISION: 'openadlc-bridge-00002' } });
    await next.resume();
    expect(world.last()).toBeNull();
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'updated', tag: 'v0.2.0' });
    expect(world.recordedWhileServing).toEqual([true]);
  });

  it('is told apart from the bridge being replaced, started again, which follows the update and records its failure', async () => {
    const bridge = world.services['openadlc-bridge']!;
    world.services['openadlc-console']!.image = TARGET.console;
    world.hostd.service = TARGET.service;
    // The update was asked for, and the old revision's instance restarted before the new one was up.
    bridge.generation = 2;
    bridge.image = TARGET.service;
    bridge.latestCreated = 'openadlc-bridge-00002';
    bridge.revisions.set('openadlc-bridge-00002', TARGET.service);
    bridge.reconciling = true;
    bridge.looksLeft = 2;
    bridge.failNext = true;
    const run: CloudSelfUpdateRun = {
      phase: 'restarting',
      tag: 'v0.2.0',
      from: COMMITS['v0.1.0']!,
      to: COMMITS['v0.2.0']!,
      trigger: 'schedule',
      actor: 'schedule',
      startedAt: '2026-10-21T10:00:00.000Z',
      pid: null,
      cloud: { fromTag: 'v0.1.0', step: 'bridge', target: TARGET, previous: { console: mirrorRef('console', 'v0.1.0'), bridge: mirrorRef('service', 'v0.1.0'), service: mirrorRef('service', 'v0.1.0') }, rolled: ['console', 'host'], generation: 2 },
    };
    world.settings.selfUpdateRun = JSON.stringify(run);
    const old = world.updater();
    expect((await old.resume())[0]).toMatch(/^this bridge runs .*service@sha256:.*, and follows the bridge's update to v0\.2\.0$/);
    await until(() => world.last() !== null);
    expect(world.last()).toMatchObject({ state: 'failed', step: 'bridge', actor: 'schedule' });
    // The bridge's service goes back on the image this bridge runs.
    expect(world.events).toEqual(['PATCH openadlc-bridge']);
    expect(bridge.image).toBe(mirrorRef('service', 'v0.1.0'));
    expect(world.last()?.reason).toContain(`the bridge's service is back on ${mirrorRef('service', 'v0.1.0')}`);
  });

  it('goes on from where a roll was cut off, once no task runs, and rolls nothing twice', async () => {
    const console = world.services['openadlc-console']!;
    console.image = TARGET.console;
    console.revisions.set('openadlc-console-00002', TARGET.console);
    console.generation = 2;
    console.observedGeneration = 2;
    console.latestCreated = console.latestReady = 'openadlc-console-00002';
    world.settings.selfUpdateRun = JSON.stringify({
      phase: 'restarting',
      tag: 'v0.2.0',
      from: COMMITS['v0.1.0']!,
      to: COMMITS['v0.2.0']!,
      trigger: 'console',
      actor: 'jane@example.com',
      startedAt: '2026-10-21T10:00:00.000Z',
      pid: null,
      cloud: { fromTag: 'v0.1.0', step: 'host', target: TARGET, previous: { console: mirrorRef('console', 'v0.1.0'), bridge: mirrorRef('service', 'v0.1.0'), service: mirrorRef('service', 'v0.1.0') }, rolled: ['console'] },
    } satisfies CloudSelfUpdateRun);
    world.live = [{ id: 't1', bot: 'builder', subjectRef: 'openadlc#12', kind: 'build' }];
    const update = world.updater();
    expect(await update.resume()).toEqual(['the OpenADLC update to v0.2.0 goes on from the host once no task runs']);
    await until(() => world.run()?.phase === 'waiting');
    expect(world.holds).toHaveLength(1);
    expect(world.events).toEqual([]);
    world.live = [];
    await until(() => world.events.length === 2);
    expect(world.events).toEqual(['POST hostd', 'PATCH openadlc-bridge']);
  });
});

describe('with self_update off', () => {
  it('says so, with the command to roll by hand, and deploys nothing', async () => {
    const env = { ...world.env, OPENADLC_SELF_UPDATE: 'off' };
    // Off, the module grants the bridge nothing on Cloud Run.
    world.denyCloudRun = true;
    const update = world.updater({ env });
    const view = await update.view();
    expect(view.backend).toBe('cloud');
    expect(view.applicable).toBe(false);
    expect(view.reason).toBe(
      "self-update is off on this install (the cloud module's self_update is false), so the bridge does not deploy its own services: roll it onto a release by hand with openadlc cloud update --release <tag>",
    );
    await update.start({ trigger: 'schedule', actor: 'schedule' });
    expect(world.last()).toMatchObject({ state: 'skipped', reason: view.reason });
    expect(world.events).toEqual([]);
    expect(world.calls.filter((call) => call.args[1] === 'verify' && !call.args.includes('--help'))).toEqual([]);
  });
});

describe('what a stop says', () => {
  it('names each part on the release and each not, the command that finishes it, and what goes back', () => {
    const install = cloudInstallFrom(world.env)!.install;
    const previous = { console: 'c0', bridge: 's0', service: 's0' };
    expect(cloudStopReason({ problem: 'it broke.', tag: 'v0.2.0', fromTag: 'v0.1.0', rolled: [], target: TARGET, previous, install })).toBe(
      'it broke. Nothing was rolled: the console, the host and the bridge are still on v0.1.0. The install is as it was',
    );
    const both = cloudStopReason({ problem: 'it broke', tag: 'v0.2.0', fromTag: 'v0.1.0', rolled: ['console', 'host'], target: TARGET, previous, install });
    expect(both).toContain('The console and the host run v0.2.0');
    expect(both).toContain('the bridge is still on v0.1.0. To finish: openadlc cloud update --release v0.2.0. To go back to v0.1.0, put back the console onto c0');
    // s0 is no release image, as the module's hostd_image by tag is not: only removing both files brings that back.
    expect(both).toContain(
      "and the host onto the module's hostd_image, s0 (on the host: sudo rm -f /var/lib/fleet/hostd-image /var/lib/fleet/hostd-image.started && sudo systemctl restart fleet-hostd;",
    );
    expect(both).toContain('(the console on ' + TARGET.console + '; hostd on ' + TARGET.service + ')');
  });
});
