import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSecretStore, internalSecretRef } from '@openadlc/github';
import {
  attestationRunProblem,
  DEFAULT_PORTS,
  IMAGE_DIGEST,
  imageAttestationCheckArgs,
  imageAttestationsUrl,
  ONE_RELEASE_AT_A_TIME,
  PROJECT_REPOSITORY,
  RELEASE_CHECKSUMS,
  RELEASE_IMAGE_DIGESTS,
  RELEASE_IMAGE_REGISTRY,
  RELEASE_IMAGES,
  recordedImageDigests,
  recordsImageDigests,
  releaseAssetUrl,
  releaseImageName,
  releaseImageRef,
  type MovedImageTag,
  type PublishedRelease,
  type ReleaseImage,
  type SelfUpdateRun,
} from '@openadlc/shared';

/**
 * Self-update on a Google Cloud install (docs/self-hosting.md#updating-a-cloud-install):
 * what `self-update.ts` does in place of a checkout's restart.
 *
 * Such an install runs no checkout. The bridge and the console are Cloud Run
 * services, and hostd runs on a host whose `fleet-hostd` unit starts it from
 * an image; all three run a release's images (`RELEASE_IMAGES`: the bridge
 * and hostd `service`, the console `console`), by digest, through the
 * install's Artifact Registry mirror of ghcr.io. The bots' image is not a
 * release's: it holds Claude Code, which a release may not redistribute, so
 * the host builds its own and the weekly engine update keeps it current, as
 * on any install. Everything up to
 * the apply is the checkout's: the releases, the schedule and Update now, the
 * wait for the tasks with new work held, the records and the card. What
 * differs is here:
 *
 * - **What runs.** The release the install is on is the one whose `service`
 *   image is the digest the bridge's own revision runs, asked of Cloud Run,
 *   matched against the digest each release recorded (`images.json`), or its
 *   tag at the registry for a release from before releases recorded them, and
 *   checked as that release's. A cloud install takes
 *   only the next release after it (`nextRelease`): its bridge and its host
 *   each migrate the database as they start, so each release has to run beside
 *   the one before it, and only beside that one.
 * - **Preparing** is checking: each image's digest is the one the release
 *   recorded, checked against its `SHA256SUMS` and pulled by that digest at
 *   the registry, anonymously, or, for a release from before releases
 *   recorded them, its tag resolved there; and the digest checked with `gh
 *   attestation verify` as the archive is (`imageAttestationCheckArgs`,
 *   against the bundles GitHub's attestations API keeps for it, and the run
 *   read back from `--format json`). Nothing rolls unless both check out, and
 *   only the digest is ever deployed, never the tag. A tag pushed again since
 *   the release, naming another digest now, is said, and changes nothing.
 * - **The apply**, once no task runs: (a) the console's Cloud Run service onto
 *   the console digest, waiting until its new revision serves; (b) hostd told
 *   to restart onto the service digest (`POST /internal/restart-onto-image`,
 *   apps/hostd/src/restart-onto-image.ts), waiting until a new hostd answers
 *   on it; (c) the bridge's own service,
 *   last, with the run written down first: this instance is replaced, and the
 *   bridge that comes up finishes the record from it and the image it runs.
 *
 * The bridge deploys as its own service account, which the cloud module lets
 * deploy these two services, act as their two runtime accounts and read the
 * mirror, and nothing more, only while `self_update` is on
 * (docs/security.md#what-self-update-on-a-cloud-install-grants).
 */

/** What the cloud module told the bridge about the install it is part of. */
export interface CloudInstall {
  project: string;
  region: string;
  bridgeService: string;
  consoleService: string;
  /** The mirror of ghcr.io, up to and including `<name_prefix>-ghcr`. */
  mirror: string;
  /** The repository releases are taken from. */
  repo: string;
  /** The module's `self_update`: whether this bridge may deploy its own services. */
  selfUpdate: boolean;
  hostdUrl: string;
  /** This instance's own Cloud Run revision (`K_REVISION`). */
  revision: string | null;
}

/** What the module sets for the apply; one missing is a module older than the bridge. */
const REQUIRED = ['OPENADLC_CLOUD_PROJECT', 'OPENADLC_CLOUD_REGION', 'OPENADLC_CLOUD_BRIDGE_SERVICE', 'OPENADLC_CLOUD_CONSOLE_SERVICE', 'OPENADLC_RELEASE_MIRROR'] as const;

/**
 * The cloud install this bridge belongs to, and what of it the module did not
 * set, or null when it is not one (`OPENADLC_CLOUD` is not `gcp`), and the
 * checkout's self-update applies.
 */
export function cloudInstallFrom(env: NodeJS.ProcessEnv): { install: CloudInstall; missing: string[] } | null {
  if (env.OPENADLC_CLOUD?.trim() !== 'gcp') return null;
  const value = (name: string): string => env[name]?.trim() ?? '';
  return {
    install: {
      project: value('OPENADLC_CLOUD_PROJECT'),
      region: value('OPENADLC_CLOUD_REGION'),
      bridgeService: value('OPENADLC_CLOUD_BRIDGE_SERVICE'),
      consoleService: value('OPENADLC_CLOUD_CONSOLE_SERVICE'),
      mirror: value('OPENADLC_RELEASE_MIRROR').replace(/\/+$/, ''),
      // The module's own default is the same repository (infra/gcp, `release_repository`).
      repo: value('OPENADLC_RELEASE_REPO') || PROJECT_REPOSITORY,
      // Only `on` deploys: a module from before the variable granted the
      // bridge nothing to deploy with.
      selfUpdate: value('OPENADLC_SELF_UPDATE') === 'on',
      hostdUrl: (value('OPENADLC_HOSTD_URL') || `http://127.0.0.1:${DEFAULT_PORTS.hostd}`).replace(/\/+$/, ''),
      revision: value('K_REVISION') || null,
    },
    missing: REQUIRED.filter((name) => !value(name)),
  };
}

// ------------------------------------------------------------------ the run

export type CloudPart = 'console' | 'host' | 'bridge';
/** Where a cloud run is: checking the images, then each part rolled in turn. */
export type CloudStep = 'images' | CloudPart;

/** A release's images in the mirror, by digest: the bridge and hostd run `service`. */
export interface CloudImages {
  service: string;
  console: string;
}

/** What ran before the roll, read before anything changed: what going back puts back. */
export interface CloudBefore {
  console: string;
  bridge: string;
  /** hostd's image, as the host's unit says it started it: on a fresh install the module's `hostd_image`, a tag; null from a unit that does not say. */
  service: string | null;
}

export interface CloudRunState {
  /** The release the install was on when the run started. */
  fromTag: string;
  step: CloudStep;
  /** The checked images, once they are. */
  target: CloudImages | null;
  previous: CloudBefore | null;
  /** The parts on the release already, in the order they rolled. */
  rolled: CloudPart[];
  /** The release's tags that named another digest than it recorded, when its images were checked. */
  moved?: MovedImageTag[];
  /** The bridge service's generation its own update makes, once asked for. */
  generation?: number;
}

/** A run as `selfUpdateRun` keeps it on a cloud install: the checkout's, with where the roll is. */
export type CloudSelfUpdateRun = SelfUpdateRun & { cloud?: CloudRunState };

// ------------------------------------------------------------------ which release

/** The row's words when the newest release is further ahead than the one a run takes. */
export function nextReleaseNote(next: string, newest: string): string {
  return `takes the next release, ${next}, not ${newest}: ${ONE_RELEASE_AT_A_TIME}`;
}

// ------------------------------------------------------------------ what a stop says

function names(parts: readonly CloudPart[]): string {
  const words = parts.map((part) => `the ${part}`);
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function capital(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/**
 * How the host goes back onto what it ran, as a person runs it on the host.
 * The host's unit takes the image file only when it names this install's
 * release image by digest; anything else it passes over for the image hostd
 * last started on (`/var/lib/fleet/hostd-image.started`, which is the new
 * release once hostd came up on it), and only then for the module's
 * `hostd_image`. So a release image goes back by writing it into the file,
 * and the module's own image (a tag, on a fresh install) only by removing
 * both files.
 */
function hostBack(previous: string | null, install: CloudInstall): string {
  const release = `${install.mirror}/${install.repo.toLowerCase()}/service@`;
  if (previous?.startsWith(release) && /@sha256:[0-9a-f]{64}$/.test(previous)) {
    return `the host onto ${previous} (on the host: sudo sh -c 'echo ${previous} > /var/lib/fleet/hostd-image' && sudo systemctl restart fleet-hostd)`;
  }
  return `the host onto the module's hostd_image${previous ? `, ${previous}` : ''} (on the host: sudo rm -f /var/lib/fleet/hostd-image /var/lib/fleet/hostd-image.started && sudo systemctl restart fleet-hostd; removing only the first starts it on the image it last ran, the new release)`;
}

/** A finished run's reason: what each part runs now. */
export function cloudUpdatedReason(tag: string, target: CloudImages): string {
  return `the console, the host and the bridge run ${tag}: the bridge and hostd on ${target.service}, the console on ${target.console}`;
}

/**
 * A run that stopped, in the words its record keeps: what went wrong, which
 * parts are on the release and which are not, and the command that finishes
 * it or what goes back. Nothing rolled is the install as it was.
 */
export function cloudStopReason(input: {
  problem: string;
  tag: string;
  fromTag: string;
  rolled: readonly CloudPart[];
  target: CloudImages | null;
  previous: CloudBefore | null;
  install: CloudInstall;
  /** False when the part that failed could not be put back on what it ran. */
  asItWas?: boolean;
}): string {
  const problem = input.problem.trim().replace(/\.$/, '');
  const clipped = problem.length > 500 ? `${problem.slice(0, 499)}…` : problem;
  const parts: CloudPart[] = ['console', 'host', 'bridge'];
  const still = parts.filter((part) => !input.rolled.includes(part));
  if (input.rolled.length === 0 || !input.target) {
    return `${clipped}. Nothing was rolled: the console, the host and the bridge are still on ${input.fromTag}.${input.asItWas === false ? '' : ' The install is as it was'}`;
  }
  const target = input.target;
  const on = input.rolled.map((part) => (part === 'console' ? `the console on ${target.console}` : part === 'host' ? `hostd on ${target.service}` : `the bridge on ${target.service}`));
  const words = [
    `${clipped}.`,
    `${capital(names(input.rolled))} ${input.rolled.length === 1 ? 'runs' : 'run'} ${input.tag} (${on.join('; ')}); ${names(still)} ${still.length === 1 ? 'is' : 'are'} still on ${input.fromTag}.`,
    `To finish: openadlc cloud update --release ${input.tag}.`,
  ];
  const previous = input.previous;
  if (previous) {
    const back = input.rolled.map((part) =>
      part === 'console'
        ? `the console onto ${previous.console} (gcloud run services update ${input.install.consoleService} --project ${input.install.project} --region ${input.install.region} --image ${previous.console})`
        : part === 'host'
          ? hostBack(previous.service, input.install)
          : `the bridge onto ${previous.bridge}`,
    );
    words.push(`To go back to ${input.fromTag}, put back ${back.join(', and ')}`);
  }
  return words.join(' ');
}

// ------------------------------------------------------------------ the mechanics

interface ServiceContainer {
  name?: string;
  image?: string;
}

/** The parts of a Cloud Run v2 Service this reads. */
interface RunService {
  name?: string;
  generation?: string | number;
  observedGeneration?: string | number;
  reconciling?: boolean;
  etag?: string;
  template?: { containers?: ServiceContainer[] };
  terminalCondition?: { state?: string; message?: string; reason?: string };
  latestReadyRevision?: string;
  latestCreatedRevision?: string;
  trafficStatuses?: { type?: string; revision?: string; percent?: number }[];
}

/** What Cloud Run computes, and a v2 update leaves out of what it is sent. */
const OUTPUT_ONLY = [
  'uid',
  'generation',
  'createTime',
  'updateTime',
  'deleteTime',
  'expireTime',
  'creator',
  'lastModifier',
  'observedGeneration',
  'terminalCondition',
  'conditions',
  'latestReadyRevision',
  'latestCreatedRevision',
  'trafficStatuses',
  'uri',
  'urls',
  'reconciling',
  'satisfiesPzs',
] as const;

export type RollState = { state: 'serving' } | { state: 'pending'; why?: string } | { state: 'failed'; reason: string };

export interface HostImage {
  service: string | null;
  startedAt: string | null;
  /** The tasks running or starting on the host, which a restart would end. */
  busy: string[];
}

export interface CloudUpdateDeps {
  install: CloudInstall;
  /** What the module did not set; the row names them. */
  missing?: readonly string[];
  fetch: typeof fetch;
  /** The token the bridge reads GitHub's API with, sent only on the request for an image's attestations; none when absent. */
  githubToken?: () => Promise<string | null>;
  /** Runs a command and answers its standard output, as self-update's `run`. */
  run(command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<string>;
  /** Where a check writes what it reads, in a directory of its own it removes after: under the install's home. */
  workRoot: string;
  /** The install's internal secret, which hostd's routes take; the secret store's when absent. */
  hostdSecret?: () => Promise<string | null>;
  /** How often a roll looks again. */
  pollMs?: number;
  /** How long a Cloud Run service's new revision may take to serve. */
  rollMaxMs?: number;
  /** How long hostd may take to come back: the host pulls the image, copies it out and applies its migrations before it starts it. */
  hostMaxMs?: number;
  log?: (line: string) => void;
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];

const DIGEST = /@(sha256:[0-9a-f]{64})$/;

/** The digest a reference is pinned to, or null for a tag. */
export function digestOf(ref: string): string | null {
  return DIGEST.exec(ref)?.[1] ?? null;
}

/** The last name of an image's path: `service` of `…/openadlc/service@sha256:…`. */
function lastName(ref: string): string {
  const name = ref.split('@')[0] ?? '';
  return (name.split('/').at(-1) ?? '').split(':')[0] ?? '';
}

function short(revision: string | undefined): string {
  return (revision ?? '').split('/').at(-1) ?? '';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function minutes(ms: number): string {
  const count = Math.max(1, Math.round(ms / 60_000));
  return count === 1 ? 'a minute' : `${count} minutes`;
}

/**
 * The environment `gh` checks an image in: no GitHub credential at all, as
 * for the archive, and a config directory of its own that is empty, so a
 * sign-in on the machine is not read either. With `--bundle` gh needs none;
 * `--bundle-from-oci` asked for one, and given a stand-in said it was denied.
 */
export function imageCheckEnv(configDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_CONFIG_DIR: configDir };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete out[name];
  return out;
}

/** How big an image's attestations may be: a bundle is some kilobytes, and a digest has a few. */
const ATTESTATIONS_LIMIT = 4 * 1024 * 1024;

/** How big `SHA256SUMS` and `images.json` may be: a line a file, and two digests. */
const RECORD_LIMIT = 64 * 1024;

/** What `verify` found: the images to roll, and any tag of the release that names another digest now. */
export interface CheckedImages {
  images: CloudImages;
  moved: MovedImageTag[];
}

/** hostd's refusal of a restart, or what it came back on: not hostd being away while it restarts. */
class HostRefused extends Error {}

export class CloudUpdate {
  readonly install: CloudInstall;
  readonly missing: readonly string[];
  private readonly log: (line: string) => void;
  private accessToken: { value: string; until: number } | null = null;
  /**
   * Tag to digest, per image, for a release that recorded no digests: as such
   * a release was always taken, each is asked once. A release's tag can be
   * pushed again, which is why a later release records its digests instead.
   */
  private readonly digests = new Map<string, string>();
  /** A release's `SHA256SUMS` and `images.json`, by tag: a release's files never change, so each is read once. */
  private readonly records = new Map<string, { sums: string; file: Buffer }>();

  constructor(private readonly deps: CloudUpdateDeps) {
    this.install = deps.install;
    this.missing = deps.missing ?? [];
    this.log = deps.log ?? ((line) => console.log(`[bridge] ${line}`));
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? 5_000));
  }

  // ---------------------------------------------------------------- the registry

  /** An image in the install's mirror, which is where Cloud Run and the host pull it from. */
  mirrorRef(repo: string, image: ReleaseImage, digest: string): string {
    return `${this.install.mirror}/${releaseImageName(repo, image).slice(RELEASE_IMAGE_REGISTRY.length + 1)}@${digest}`;
  }

  /**
   * The digest of the manifest at a reference, a tag or a digest, asked with
   * an anonymous pull token, as for any public image, and taken from the
   * manifest's own bytes: the header that also says it is the registry's
   * word, and has to agree.
   */
  private async manifestDigest(repo: string, image: ReleaseImage, reference: string): Promise<string> {
    const byDigest = IMAGE_DIGEST.test(reference);
    const ref = byDigest ? `${releaseImageName(repo, image)}@${reference}` : releaseImageRef(repo, image, reference);
    const path = releaseImageName(repo, image).slice(RELEASE_IMAGE_REGISTRY.length + 1);
    const grant = await this.deps.fetch(`https://${RELEASE_IMAGE_REGISTRY}/token?service=${RELEASE_IMAGE_REGISTRY}&scope=${encodeURIComponent(`repository:${path}:pull`)}`, {
      headers: { 'user-agent': 'openadlc-self-update' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!grant.ok) {
      throw new Error(`${RELEASE_IMAGE_REGISTRY} gave no anonymous pull of ${path} (${grant.status}); a release's images are public once someone has made the two packages public on GitHub`);
    }
    const { token } = (await grant.json()) as { token?: unknown };
    if (typeof token !== 'string' || !token) throw new Error(`${RELEASE_IMAGE_REGISTRY} answered no pull token for ${path}`);
    const response = await this.deps.fetch(`https://${RELEASE_IMAGE_REGISTRY}/v2/${path}/manifests/${byDigest ? reference : encodeURIComponent(reference)}`, {
      headers: { accept: MANIFEST_TYPES.join(', '), authorization: `Bearer ${token}`, 'user-agent': 'openadlc-self-update' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${ref} is not at the registry (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 4 * 1024 * 1024) throw new Error(`${ref}'s manifest is ${bytes.length} bytes, more than an image's is`);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const said = response.headers.get('docker-content-digest');
    if (said && said !== digest) throw new Error(`the registry says ${ref} is ${said}, and its manifest is ${digest}`);
    return digest;
  }

  /** The digest a release's tag names at the registry now, asked every time: a tag can be pushed again. */
  tagDigest(repo: string, image: ReleaseImage, tag: string): Promise<string> {
    return this.manifestDigest(repo, image, tag);
  }

  /** The digest a release's tag names, for a release from before releases recorded their digests: asked once, as it always was. */
  async resolveDigest(repo: string, image: ReleaseImage, tag: string): Promise<string> {
    const ref = releaseImageRef(repo, image, tag);
    const known = this.digests.get(ref);
    if (known) return known;
    const digest = await this.tagDigest(repo, image, tag);
    this.digests.set(ref, digest);
    return digest;
  }

  /**
   * That the registry serves a digest a release recorded, without a sign-in,
   * as the install's mirror will fetch it: its manifest, whose bytes hash to
   * it. A version deleted from the package since is refused here, before
   * anything rolls, rather than by Cloud Run or the host mid-roll.
   */
  async pullable(repo: string, image: ReleaseImage, digest: string): Promise<void> {
    const served = await this.manifestDigest(repo, image, digest);
    if (served !== digest) throw new Error(`the registry served a manifest whose digest is ${served} for ${digest}`);
  }

  /** One small file of a release, from the release's own address, carrying no credential. */
  private async releaseFile(repo: string, tag: string, name: string): Promise<Buffer> {
    const url = releaseAssetUrl(repo, tag, name);
    const response = await this.deps.fetch(url, { redirect: 'follow', headers: { 'user-agent': 'openadlc-self-update' }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > RECORD_LIMIT) throw new Error(`${url} is ${declared} bytes, more than a release's ${name} is`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > RECORD_LIMIT) throw new Error(`${url} is more than ${RECORD_LIMIT} bytes, more than a release's ${name} is`);
    return bytes;
  }

  /**
   * The digests a release recorded of its images, from its `images.json` as
   * its `SHA256SUMS` gives it (`recordedImageDigests`), and of `commit` when
   * that is known. Throws when they cannot be read or taken: such a release is
   * taken by its record or not at all, never by its tags.
   */
  async recordedDigests(repo: string, tag: string, commit?: string): Promise<Record<ReleaseImage, string>> {
    let files = this.records.get(tag);
    if (!files) {
      const sums = (await this.releaseFile(repo, tag, RELEASE_CHECKSUMS)).toString('utf8');
      const file = await this.releaseFile(repo, tag, RELEASE_IMAGE_DIGESTS);
      files = { sums, file };
    }
    const read = recordedImageDigests({ tag, sums: files.sums, file: files.file, ...(commit === undefined ? {} : { commit }) });
    if ('problem' in read) throw new Error(read.problem);
    this.records.set(tag, files);
    return read.images;
  }

  /**
   * The tags of a release that recorded its digests which name another
   * digest at the registry now. None for a release that recorded none, whose
   * tags are what it is taken by. A tag that cannot be read is not compared:
   * what is taken is the recorded digest either way.
   */
  async movedTags(repo: string, release: Pick<PublishedRelease, 'tag' | 'assets'>): Promise<MovedImageTag[]> {
    if (!recordsImageDigests(release)) return [];
    const recorded = await this.recordedDigests(repo, release.tag);
    const moved: MovedImageTag[] = [];
    for (const image of RELEASE_IMAGES) {
      const now = await this.tagDigest(repo, image, release.tag).catch(() => null);
      if (now && now !== recorded[image]) moved.push({ tag: release.tag, image, recorded: recorded[image], now });
    }
    return moved;
  }

  /**
   * A release's images, checked, as mirror references: each the digest the
   * release recorded, served by the registry, or, for a release from before
   * releases recorded them, its tag resolved to a digest; each digest's
   * attestation checked as the archive's is (`checkImage`). Throws at the
   * first that does not check out, so nothing rolls unless every one does.
   * A recorded digest is taken whatever its tag names now; a tag that names
   * another is answered in `moved`, for the row and the audit log to say.
   */
  async verify(repo: string, release: Pick<PublishedRelease, 'tag' | 'assets'>, commit: string): Promise<CheckedImages> {
    const tag = release.tag;
    const recorded = recordsImageDigests(release)
      ? await this.recordedDigests(repo, tag, commit).catch((error: unknown) => {
          throw new Error(`could not read the digests ${tag} recorded of its images: ${message(error)}, so nothing is rolled`);
        })
      : null;
    const refs: Partial<CloudImages> = {};
    for (const image of RELEASE_IMAGES) {
      let digest: string;
      if (recorded) {
        digest = recorded[image];
        await this.pullable(repo, image, digest).catch((error: unknown) => {
          throw new Error(`${releaseImageName(repo, image)}@${digest}, the ${image} image ${tag} recorded, cannot be pulled: ${message(error)}, so nothing is rolled`);
        });
      } else {
        digest = await this.resolveDigest(repo, image, tag).catch((error: unknown) => {
          throw new Error(`could not resolve ${releaseImageRef(repo, image, tag)} to a digest: ${message(error)}`);
        });
      }
      const problem = await this.checkImage(repo, image, digest, tag, commit);
      if (problem) throw new Error(`${problem}, so nothing is rolled`);
      refs[image] = this.mirrorRef(repo, image, digest);
    }
    const moved = recorded ? await this.movedTags(repo, release).catch(() => []) : [];
    return { images: refs as CloudImages, moved };
  }

  /**
   * Why an image at a digest is not the one the release workflow signed for
   * that tag and commit, or null when it is. Its attestations are read from
   * GitHub's attestations API without a sign-in, carrying no credential,
   * bounded in time and size, and written one bundle a line to a file of the
   * run's own, which `gh attestation verify --bundle` checks with no GitHub
   * credential and is removed after. The API's answer is data: only what gh
   * verifies against Sigstore's root counts.
   */
  async checkImage(repo: string, image: ReleaseImage, digest: string, tag: string, commit: string): Promise<string | null> {
    const subject = `${releaseImageName(repo, image)}@${digest}`;
    let bundles: string[];
    try {
      bundles = await this.attestationBundles(repo, digest);
    } catch (error) {
      return `could not read ${subject}'s attestations from GitHub: ${message(error)}`;
    }
    if (bundles.length === 0) return `GitHub has no attestation of ${subject}`;
    // The run's own directory (`selfUpdatePaths(home, tag).root`).
    const root = join(this.deps.workRoot, tag);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(root, 'attestations-'));
    try {
      const bundle = join(dir, 'bundles.jsonl');
      writeFileSync(bundle, `${bundles.join('\n')}\n`, { mode: 0o600 });
      const config = join(dir, 'gh');
      mkdirSync(config, { mode: 0o700 });
      let verified: string;
      try {
        verified = await this.deps.run('gh', [...imageAttestationCheckArgs({ repo, image, digest, tag, commit, bundle }), '--format', 'json'], { cwd: dir, timeoutMs: 120_000, env: imageCheckEnv(config) });
      } catch (error) {
        return `gh attestation verify refused ${subject} as ${tag}'s: ${message(error).slice(0, 500)}`;
      }
      const problem = attestationRunProblem(verified, { repo, tag });
      return problem ? `${problem}, for ${subject}` : null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      try {
        rmdirSync(root);
      } catch {
        // Something else of the run's is in it.
      }
    }
  }

  /**
   * Every attestation bundle GitHub keeps for a digest, each as one line of
   * JSON. Asked with the token the bridge reads GitHub with, when it has one:
   * Cloud Run's egress shares Google's addresses, and GitHub allows 60
   * requests an hour without a token to an address, which a busy neighbour
   * could spend. The token goes on this request alone; `gh` is still given
   * none. One GitHub refuses is dropped for an anonymous ask.
   */
  private async attestationBundles(repo: string, digest: string): Promise<string[]> {
    const token = this.deps.githubToken ? await this.deps.githubToken().catch(() => null) : null;
    const ask = (withToken: boolean) =>
      this.deps.fetch(imageAttestationsUrl(repo, digest), {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'openadlc-self-update',
          'x-github-api-version': '2022-11-28',
          ...(withToken && token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    let response = await ask(true);
    if (token && response.status === 401) response = await ask(false);
    // None kept is GitHub's 404, which is the same as an empty list here.
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > ATTESTATIONS_LIMIT) throw new Error(`its answer is ${declared} bytes, more than an image's attestations are`);
    const text = await response.text();
    if (Buffer.byteLength(text) > ATTESTATIONS_LIMIT) throw new Error(`its answer is more than ${ATTESTATIONS_LIMIT} bytes, more than an image's attestations are`);
    const body = JSON.parse(text) as { attestations?: { bundle?: unknown }[] };
    return (body.attestations ?? []).filter((one) => one && typeof one.bundle === 'object' && one.bundle !== null).map((one) => JSON.stringify(one.bundle));
  }

  /**
   * The release whose `service` image is this digest, among releases newest
   * first, or null: the digest it recorded, or what its tag names for one from
   * before releases recorded them. A release that recorded its digests is
   * never matched by its tag, which could name another release's image.
   */
  async releaseOf(repo: string, digest: string, releases: readonly PublishedRelease[]): Promise<string | null> {
    for (const release of releases) {
      const theirs = recordsImageDigests(release)
        ? await this.recordedDigests(repo, release.tag).then(
            (images) => images.service,
            () => null,
          )
        : await this.resolveDigest(repo, 'service', release.tag).catch(() => null);
      if (theirs === digest) return release.tag;
    }
    return null;
  }

  // ---------------------------------------------------------------- Cloud Run

  /** The bridge's own service account's token, from the metadata server Cloud Run gives every instance. */
  private async googleToken(): Promise<string> {
    if (this.accessToken && this.accessToken.until > Date.now()) return this.accessToken.value;
    const response = await this.deps.fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`the metadata server gave no token (${response.status})`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('the metadata server gave no token');
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 300;
    this.accessToken = { value: body.access_token, until: Date.now() + Math.max(30, seconds - 60) * 1000 };
    return body.access_token;
  }

  private serviceName(part: 'console' | 'bridge'): string {
    const service = part === 'console' ? this.install.consoleService : this.install.bridgeService;
    return `projects/${this.install.project}/locations/${this.install.region}/services/${service}`;
  }

  private async google<T>(method: 'GET' | 'PATCH', name: string, body?: unknown, query = ''): Promise<T> {
    const token = await this.googleToken();
    const response = await this.deps.fetch(`https://run.googleapis.com/v2/${name}${query}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'openadlc-self-update' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let said = '';
      try {
        said = String((JSON.parse(text) as { error?: { message?: unknown } }).error?.message ?? '');
      } catch {
        // Not Google's error shape: the status says enough.
      }
      const hint =
        response.status === 403
          ? ': the bridge may deploy only its own two services, and only with self_update on; run openadlc cloud apply'
          : response.status === 409 || response.status === 412
            ? ': it was changed by something else meanwhile'
            : '';
      throw new Error(`Cloud Run answered ${response.status} to ${method} ${short(name)}${said ? ` (${said.slice(0, 300)})` : ''}${hint}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Which container of a service is the part's: its only one, or the one running the part's image. */
  private containerOf(service: RunService, part: 'console' | 'bridge'): number {
    const containers = service.template?.containers ?? [];
    if (containers.length === 1) return 0;
    const wanted = part === 'console' ? 'console' : 'service';
    const index = containers.findIndex((container) => lastName(container.image ?? '') === wanted);
    if (index < 0) throw new Error(`the ${part}'s Cloud Run service has ${containers.length} containers and none runs the ${wanted} image, so which to update is not clear`);
    return index;
  }

  /** The image a part's service names now. */
  async serviceImage(part: 'console' | 'bridge'): Promise<string> {
    const service = await this.google<RunService>('GET', this.serviceName(part));
    const image = service.template?.containers?.[this.containerOf(service, part)]?.image;
    if (!image) throw new Error(`the ${part}'s Cloud Run service names no image`);
    return image;
  }

  /**
   * The image this instance runs: its own revision's (`K_REVISION`), which
   * is the service's newest until a self-update makes another, and is not
   * the service's newest in the bridge being replaced.
   */
  async ownImage(): Promise<string> {
    const name = this.serviceName('bridge');
    const service = await this.google<RunService>('GET', name);
    const revision = this.install.revision;
    if (revision && short(service.latestCreatedRevision) !== revision) {
      const own = await this.google<{ containers?: ServiceContainer[] }>('GET', `${name}/revisions/${revision}`);
      const containers = own.containers ?? [];
      const image = (containers.length === 1 ? containers[0] : containers.find((container) => lastName(container.image ?? '') === 'service'))?.image;
      if (image) return image;
    }
    const image = service.template?.containers?.[this.containerOf(service, 'bridge')]?.image;
    if (!image) throw new Error(`the bridge's Cloud Run service names no image`);
    return image;
  }

  /**
   * Asks Cloud Run for a part's service on an image: the service as it is,
   * with only that container's image changed, sent back with its etag so a
   * change made meanwhile refuses the update rather than being written over.
   * Answers the generation to wait for; the one there when it names the image
   * already.
   *
   * The update names `template` as the one field it sets. `updateMask` is
   * optional in Cloud Run v2's `services.patch` ("Optional. The list of
   * fields to be updated."), and without it the whole service sent is the
   * update; narrowed to the revision template, nothing else of the service
   * can change, though the body carries all of it. Both services set
   * `invokerIamDisabled`, and changing that takes `run.services.setIamPolicy`,
   * which the bridge's role leaves out on purpose; Cloud Run's documentation
   * says the permission is needed to disable or re-enable the check, and not
   * whether an update that leaves it as it is needs it (docs/unverified.md,
   * U89). The field stays in the body as it was read, so an update that
   * applied the whole of it would still leave the check off rather than turn
   * it back on.
   */
  async requestRoll(part: 'console' | 'bridge', image: string): Promise<number> {
    const name = this.serviceName(part);
    const service = await this.google<RunService & Record<string, unknown>>('GET', name);
    const index = this.containerOf(service, part);
    const generation = Number(service.generation ?? 0);
    if (service.template?.containers?.[index]?.image === image) return generation;
    const body: Record<string, unknown> = JSON.parse(JSON.stringify(service)) as Record<string, unknown>;
    for (const field of OUTPUT_ONLY) delete body[field];
    (body.template as { containers: ServiceContainer[] }).containers[index]!.image = image;
    await this.google('PATCH', name, body, '?updateMask=template');
    return generation + 1;
  }

  /**
   * Where a part's update is: serving once the generation it made is the one
   * Cloud Run reconciled, its newest revision is ready and the traffic is on
   * it; failed when the revision did not become ready, when the traffic is
   * held on another, or when the service names another image now.
   */
  async rollState(part: 'console' | 'bridge', image: string, generation: number): Promise<RollState> {
    const service = await this.google<RunService>('GET', this.serviceName(part));
    const named = service.template?.containers?.[this.containerOf(service, part)]?.image;
    if (named !== image) return { state: 'failed', reason: `the ${part}'s Cloud Run service names ${named ?? 'no image'} now, not ${image}: something else changed it during the update` };
    if (service.reconciling) return { state: 'pending', why: 'Cloud Run is still deploying it' };
    const condition = service.terminalCondition;
    // A reconcile that failed leaves `observedGeneration` on the generation
    // that last served (Cloud Run v2's), so waiting for it to reach the one
    // asked for waited out the whole limit, with new work held. The failure
    // is the asked-for generation's Ready condition.
    if (Number(service.generation ?? 0) >= generation && condition?.state === 'CONDITION_FAILED') {
      return { state: 'failed', reason: `the ${part}'s new revision did not become ready (${condition.message || condition.reason || 'Cloud Run gives no reason'}); Cloud Run goes on serving the one before it` };
    }
    if (Number(service.observedGeneration ?? 0) < generation) return { state: 'pending', why: 'Cloud Run is still deploying it' };
    if (condition?.state !== 'CONDITION_SUCCEEDED' || !service.latestReadyRevision || service.latestReadyRevision !== service.latestCreatedRevision) {
      return { state: 'pending', why: 'its new revision is not ready yet' };
    }
    const ready = short(service.latestReadyRevision);
    const elsewhere = (service.trafficStatuses ?? []).filter(
      (status) => (status.percent ?? 0) > 0 && status.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' && short(status.revision) !== ready,
    );
    if (elsewhere.length > 0) {
      return { state: 'failed', reason: `the ${part}'s new revision ${ready} is ready, but its traffic is held on ${elsewhere.map((status) => short(status.revision)).join(', ')}: send it to the latest revision` };
    }
    return { state: 'serving' };
  }

  /** (a): a part's service onto an image, once its new revision serves. */
  async roll(part: 'console' | 'bridge', image: string): Promise<void> {
    const generation = await this.requestRoll(part, image);
    const limit = this.deps.rollMaxMs ?? 20 * 60_000;
    const deadline = Date.now() + limit;
    let why = '';
    for (;;) {
      const state = await this.rollState(part, image, generation).catch((error: unknown): RollState => ({ state: 'pending', why: message(error) }));
      if (state.state === 'serving') return;
      if (state.state === 'failed') throw new Error(state.reason);
      why = state.why ?? '';
      if (Date.now() > deadline) throw new Error(`the ${part}'s new revision was not serving within ${minutes(limit)}${why ? ` (${why})` : ''}`);
      await this.sleep();
    }
  }

  /**
   * A part's service onto what it ran before a roll that failed, once that
   * serves: answers whether there was anything to change. Left naming the
   * image that failed, the service is not as it was; a retry would find the
   * image already named and send no update, and the next `openadlc cloud
   * apply` or restart would deploy it unasked.
   */
  async putBack(part: 'console' | 'bridge', image: string): Promise<boolean> {
    if ((await this.serviceImage(part)) === image) return false;
    await this.roll(part, image);
    return true;
  }

  // ---------------------------------------------------------------- hostd

  private async hostd(method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    const secret = await (this.deps.hostdSecret ?? (() => getSecretStore().get(internalSecretRef())))();
    if (!secret) throw new HostRefused(`the install's internal secret is not in the secret store, so hostd cannot be asked; it is made when the bridge starts`);
    return this.deps.fetch(`${this.install.hostdUrl}/internal/restart-onto-image`, {
      method,
      headers: { 'content-type': 'application/json', 'x-openadlc-internal-secret': secret, 'x-openadlc-on-behalf-of': 'openadlc self-update' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** The image hostd runs, and when it started; a hostd from before this route says so. */
  async hostImage(): Promise<HostImage> {
    const response = await this.hostd('GET');
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 404) {
      throw new HostRefused(`hostd here has no restart-onto-image (it is from before release images), so it cannot be moved from here: roll the install by hand once with openadlc cloud update --release <tag>`);
    }
    if (!response.ok) throw new HostRefused(`hostd answered ${response.status}: ${String(body.error ?? 'no reason')}`);
    const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
    const busy = Array.isArray(body.busy) ? body.busy.filter((one): one is string => typeof one === 'string') : [];
    return { service: text(body.service), startedAt: text(body.startedAt), busy };
  }

  /**
   * (b): hostd onto the release's service image. It writes it where the
   * host's unit reads it, answers, and exits; systemd starts it again, after
   * the unit pulls it. Done once a hostd that started since answers on it;
   * one that comes back on anything else is the unit passing the file over,
   * and is said.
   */
  async restartHost(target: CloudImages): Promise<void> {
    const before = await this.hostImage();
    if (before.service === target.service) return;
    const asked = await this.hostd('POST', { service: target.service });
    if (asked.status !== 202) {
      const body = (await asked.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`hostd refused to restart onto ${target.service} (${asked.status}): ${String(body.error ?? 'no reason')}`);
    }
    const limit = this.deps.hostMaxMs ?? 30 * 60_000;
    const deadline = Date.now() + limit;
    let away = '';
    for (;;) {
      await this.sleep();
      let now: HostImage | null = null;
      try {
        now = await this.hostImage();
      } catch (error) {
        // Away, or not ready, while it restarts and the host pulls the images.
        away = message(error);
      }
      if (now && now.startedAt !== before.startedAt) {
        if (now.service === target.service) return;
        throw new Error(
          `hostd came back on ${now.service ?? 'an image it does not name'}, not on ${target.service}: the host's fleet-hostd unit passed the file over (journalctl -u fleet-hostd on the host says why)`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `hostd was not back on ${target.service} within ${minutes(limit)}${now ? '' : away ? ` (last: ${away.slice(0, 200)})` : ''}; the host may still be pulling the images (journalctl -u fleet-hostd on the host)`,
        );
      }
    }
  }
}
