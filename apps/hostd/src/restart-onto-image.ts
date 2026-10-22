import { closeSync, existsSync, fsyncSync, openSync, rmSync, writeSync } from 'node:fs';
import { writeFileDurably } from '@openadlc/shared';

/**
 * hostd moving onto a release's image, on a Google Cloud host.
 *
 * There hostd runs in a container the host's `fleet-hostd` unit starts
 * (infra/gcp/cloud-init/host.yaml). Before each start the unit reads one
 * file, `OPENADLC_HOSTD_IMAGE_FILE`, one image reference, pulls what it names
 * and runs it; a file that is missing or malformed is passed over for the
 * module's `hostd_image`. It tells hostd which it chose, as
 * `OPENADLC_HOSTD_IMAGE`, which is what hostd reports. The bridge's self-update
 * (`apps/bridge/src/cloud-update.ts`) asks hostd to restart onto a release's
 * verified `service` digest once no task runs: hostd writes the file,
 * answers, and exits with `RESTART_EXIT_CODE`, and systemd's `Restart=always`
 * starts it again on it. Nothing here pulls or checks an attestation: the
 * bridge checked the image, and the unit pulls it.
 *
 * The bots' image is not a release's: it holds Claude Code, which a release
 * may not redistribute, so the host builds its own and the weekly engine
 * update keeps it current, as it does everywhere else.
 */

/** EX_TEMPFAIL: an exit on purpose, to be started again, told apart from a crash in the journal. */
export const RESTART_EXIT_CODE = 75;

/** Where the unit reads hostd's image from, or null on a host that does not start hostd from one (a laptop, compose). */
export function imageFileFrom(env: NodeJS.ProcessEnv): string | null {
  return env.OPENADLC_HOSTD_IMAGE_FILE?.trim() || null;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** An Artifact Registry remote repository mirroring ghcr.io, as the cloud module makes it: `<region>-docker.pkg.dev/<project>/<name_prefix>-ghcr`. */
const MIRROR = /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z][a-z0-9-]*[a-z0-9]\/[a-z0-9][a-z0-9-]*-ghcr$/;

/** The repository releases come from unless the module names another, as the bridge has it. */
const DEFAULT_RELEASE_REPO = '620legal/OpenADLC';

/** The install's mirror and release repository, as the module gives them to the host. */
export interface ReleaseSource {
  /** `OPENADLC_RELEASE_MIRROR`; null when the host was not given it. */
  mirror: string | null;
  /** `OPENADLC_RELEASE_REPO`, in lower case as the registry names it. */
  repo: string;
}

export function releaseSourceFrom(env: NodeJS.ProcessEnv): ReleaseSource {
  return {
    mirror: env.OPENADLC_RELEASE_MIRROR?.trim().replace(/\/+$/, '') || null,
    repo: (env.OPENADLC_RELEASE_REPO?.trim() || DEFAULT_RELEASE_REPO).toLowerCase(),
  };
}

/**
 * Why a reference is not the release's `service` image by digest in the
 * install's mirror, or null when it is: exactly
 * `<mirror>/<owner>/<repo>/service@sha256:<64 hex>`, which is what the unit
 * accepts. A tag is refused, since only the digest is what the bridge
 * checked; so is anything else the unit would refuse, which it would pass
 * over for its own image without a word. A host not given its mirror takes
 * any Artifact Registry remote repository named as the module names one.
 */
export function mirrorDigestProblem(ref: unknown, source: ReleaseSource): string | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 512) return 'service is not an image reference';
  if (/[\s\0]/.test(ref)) return 'service has a space or a line break in it';
  const at = ref.lastIndexOf('@');
  if (at < 0 || !DIGEST.test(ref.slice(at + 1))) return `${ref} is not pinned to a sha256 digest`;
  const name = ref.slice(0, at);
  const path = `/${source.repo}/service`;
  if (!name.endsWith(path)) return `${ref} is not ${source.repo}'s service image, which hostd runs`;
  const mirror = name.slice(0, -path.length);
  if (source.mirror ? mirror !== source.mirror : !MIRROR.test(mirror)) {
    return `${ref} is not in this install's release mirror, ${source.mirror ?? '<region>-docker.pkg.dev/<project>/<name prefix>-ghcr'}`;
  }
  return null;
}

/**
 * The file, all there or not at all, and on disk before this returns
 * (`writeFileDurably`). The host's `/var/lib/fleet` is root's: when hostd,
 * which runs as uid 1000, may write the file but not the directory, it cannot
 * make the temporary file beside it, and writes the file in place, flushed. A
 * power cut in that write leaves a reference the unit refuses, and the unit
 * then starts the module's own image, which the bridge sees and reports.
 */
export function writeImageFile(path: string, ref: string): void {
  const text = `${ref}\n`;
  try {
    writeFileDurably(path, text, 0o644);
    return;
  } catch (error) {
    try {
      rmSync(`${path}.${process.pid}.tmp`, { force: true });
    } catch {
      // Nothing was made beside it.
    }
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== 'EACCES' && code !== 'EPERM') || !existsSync(path)) throw error;
  }
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** What the route needs: the file, the image this process runs, and the way out. */
export class ImageRestart {
  /** When this hostd started: the bridge waits for it to change, so the old process answering is not taken for the new one. */
  readonly startedAt: string;
  private readonly source: ReleaseSource;
  private readonly running: string | null;
  /** Set once a restart is under way: no task starts in the moment before the exit. */
  accepted = false;

  constructor(
    private readonly input: {
      file: string;
      env: NodeJS.ProcessEnv;
      /** Ends the process; `main.ts` gives `process.exit`. */
      exit: (code: number) => void;
      startedAt?: string;
    },
  ) {
    this.startedAt = input.startedAt ?? new Date().toISOString();
    this.source = releaseSourceFrom(input.env);
    // Only what the unit says it started (`-e OPENADLC_HOSTD_IMAGE=<the
    // reference it chose>`), never the file: the file may name an image the
    // unit passed over for its own, or one written since. On a fresh install
    // it is the module's `hostd_image`, a tag.
    this.running = input.env.OPENADLC_HOSTD_IMAGE?.trim() || null;
  }

  inUse(): { service: string | null; startedAt: string } {
    return { service: this.running, startedAt: this.startedAt };
  }

  /** The reference a body asks for, or why it is not one hostd takes. */
  asked(body: unknown): { service: string } | { problem: string } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { problem: 'send {"service": "<mirror>/…/service@sha256:…"}' };
    const record = body as Record<string, unknown>;
    // A bridge that sent the bots' image would be told it moved them.
    const extra = Object.keys(record).filter((key) => key !== 'service');
    if (extra.length > 0) return { problem: `hostd restarts onto its own image only, and takes no ${extra.join(', ')}: the bots' image is built on the host and kept current by the engine updates` };
    const problem = mirrorDigestProblem(record.service, this.source);
    return problem ? { problem } : { service: record.service as string };
  }

  write(service: string): void {
    writeImageFile(this.input.file, service);
  }

  exit(): void {
    this.input.exit(RESTART_EXIT_CODE);
  }
}
