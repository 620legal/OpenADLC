import { releaseRuns, repos, type ReleaseRun, type ReleaseSetting } from '@openadlc/db';
import { GitHubApiError, githubSaid, rulesetSettingsUrl, tagBlockedDetail, tagCreationBlockers, type ReleaseAsset, type RuleApi } from '@openadlc/github';
import type { HostdClient } from './hostd-client.js';

/**
 * A built release, published as the app (#344,
 * docs/adr/0071-a-release-is-tagged-and-published-as-the-app-only-after-it-is-signed.md).
 *
 * The signature covers the artifact's download URL, and GitHub gives an
 * asset its final URL (`…/releases/download/<tag>/<name>`) only once the
 * release is published, which also creates the tag. The tag may come only
 * after signing. So the order is:
 *
 * 0. a preflight that writes nothing: the app can act on both repositories,
 *    no tag ruleset stops it, the tag is free or already on the pinned SHA,
 *    and no release of the tag is published;
 * 1. a **draft** release;
 * 2. the artifact, streamed from hostd's own copy, checked for size and digest;
 * 3. the URL, built from the **uploaded asset's name as GitHub returned it**
 *    and the release repository's canonical `full_name`; nothing the
 *    release account printed is in it;
 * 4. signed by hostd, given only that URL (`POST /release/runs/:id/sign`);
 * 5. the manifest asset;
 * 6. the tag, on the row's pinned SHA, never the default branch's head;
 * 7. published;
 * 8. read back: the published asset's `browser_download_url` must be the URL
 *    signed, or the release goes back to a draft.
 *
 * Only the app's own client is used (`AppGate.client`), never the automation
 * account's fallback: a release is published under no second credential.
 *
 * Only `ReleaseService` calls `publish`, for a run #345's route started (it
 * holds the Approves check and the device-code proof). There is no route to
 * it, so nothing publishes a release around them.
 *
 * Any failure ends the row `publish_failed`, with a reason that names what
 * was left — the draft, the tag, a public release — and what to do. Nothing
 * is left public, or tagged, without the row's reason saying so.
 */

/** What the publisher asks of GitHub: `GitHubClient`'s `request` and `uploadReleaseAsset`. */
export interface PublishApi extends RuleApi {
  request<T>(method: string, path: string, body?: unknown, options?: { accept?: string; timeoutMs?: number }): Promise<T>;
  uploadReleaseAsset(repo: string, releaseId: number, name: string, body: ReadableStream<Uint8Array> | Uint8Array | string, bytes: number, contentType: string): Promise<ReleaseAsset>;
}

export interface ReleasePublisherDeps {
  /** The app's client on one repository (`AppGate.client`), or null where the app is not installed. Never the automation account. */
  app(repoFullName: string): Promise<PublishApi | null>;
  hostd: Pick<HostdClient, 'releaseArtifact' | 'signRelease' | 'deleteReleaseArtifact'> | null;
  /** The repository's release recipe, for the manifest asset's name. */
  getRelease(repoId: string): Promise<ReleaseSetting | null>;
  warn?: (message: string) => void;
}

/** A release as GitHub answers it. */
interface GitHubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  html_url: string;
  assets?: ReleaseAsset[];
}

/** Why a step stopped, in words that say what to do. */
class Stop extends Error {}

const status = (error: unknown): number | null => {
  const value = (error as { status?: unknown }).status;
  return typeof value === 'number' ? value : null;
};

const said = (error: unknown): string => (error instanceof Stop ? error.message : error instanceof GitHubApiError ? githubSaid(error) : error instanceof Error ? error.message : String(error));

/** The download URL of a published asset, as GitHub forms it: built here, then checked against GitHub's own after publishing. */
export function releaseAssetUrl(fullName: string, tag: string, assetName: string): string {
  return `https://github.com/${fullName}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

export class ReleasePublisher {
  constructor(private readonly deps: ReleasePublisherDeps) {}

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }

  /**
   * Publishes a `built` run; see the header. Answers the row as it ended, or
   * null when it was not `built` (another publisher has it, or it ended).
   */
  async publish(runId: string): Promise<ReleaseRun | null> {
    const run = await releaseRuns.byRunId(runId);
    if (!run || run.state !== 'built') return null;
    const fail = (reason: string) => releaseRuns.publishFailed(runId, reason);
    if (!run.version || !run.sha256 || !run.bytes || !run.artifactName) return fail('the run was recorded built without the fields a release is signed from: cut the release again');
    const hostd = this.deps.hostd;
    if (!hostd) return fail('this bridge has no hostd to sign the release with. Start hostd (openadlc up), then cut the release again');

    const tag = `v${run.version}`;
    const source = run.repoFullName;
    const releaseRepo = run.releaseRepo ?? source;
    const separate = releaseRepo.toLowerCase() !== source.toLowerCase();
    const sha7 = run.sha.slice(0, 7);

    // 0. The preflight: nothing is written before it passes.
    let preflight: Preflight;
    try {
      preflight = await this.preflight(run, tag, source, releaseRepo, separate);
    } catch (error) {
      return fail(`nothing was published or tagged: ${said(error)}`);
    }
    const { sourceApi, targetApi, fullName, defaultBranch } = preflight;
    const manifestName = (await this.deps.getRelease(run.repoId).catch(() => null))?.manifestAsset ?? repos.DEFAULT_MANIFEST_ASSET;
    // The admin PATCH refuses a manifest named like the artifact, but the run
    // holds the artifact's name as the recipe was at its start: a recipe
    // changed since could make the two collide on one release.
    if (manifestName === run.artifactName) {
      return fail(`nothing was published or tagged: the manifest asset's name, ${manifestName}, is the artifact's. Set the repository's release manifestAsset to another name, then cut the release again`);
    }
    if (!(await releaseRuns.toPublishing(runId, tag))) return null;

    const left: { draft: GitHubRelease | null; tagged: boolean; releaseTagged: boolean; public: boolean; leftPublic: boolean } = {
      draft: null,
      tagged: preflight.tagOnSha,
      releaseTagged: false,
      // The publish was asked for: from here the release may be public.
      public: false,
      // Public with a URL its manifest does not sign, and could not be taken back.
      leftPublic: false,
    };
    if (left.tagged) await releaseRuns.markTagged(runId);
    try {
      // 1. The draft.
      const draft = await targetApi.request<GitHubRelease>('POST', `/repos/${releaseRepo}/releases`, {
        tag_name: tag,
        name: tag,
        draft: true,
        // The built commit is in the source repository only.
        target_commitish: separate ? defaultBranch : run.sha,
        body: `Built by OpenADLC from \`${source}@${sha7}\`, cut by @${run.requestedByLogin}.`,
      });
      left.draft = draft;
      await releaseRuns.setReleaseId(runId, draft.id);

      // 2. The artifact, hostd's own copy, checked against the row.
      const artifact = await hostd.releaseArtifact(runId);
      if (artifact.sha256 !== run.sha256 || artifact.bytes !== run.bytes || artifact.version !== run.version) {
        await artifact.body.cancel().catch(() => undefined);
        throw new Stop('hostd’s kept artifact is not the one recorded for this run; cut the release again');
      }
      const uploaded = await targetApi.uploadReleaseAsset(releaseRepo, draft.id, run.artifactName, artifact.body, run.bytes, 'application/octet-stream');
      if (uploaded.state !== 'uploaded' || uploaded.size !== run.bytes) {
        throw new Stop(`GitHub holds the artifact as ${uploaded.state} with ${uploaded.size} bytes, not uploaded with ${run.bytes}; cut the release again`);
      }
      if (uploaded.digest && uploaded.digest !== `sha256:${run.sha256}`) {
        throw new Stop(`GitHub’s digest of the uploaded artifact is ${uploaded.digest}, not sha256:${run.sha256}; cut the release again`);
      }

      // 3. The URL, from GitHub's name for the asset, which may not be the one sent.
      const url = releaseAssetUrl(fullName, tag, uploaded.name);

      // 4. Signed by hostd, from its own record; only the URL is sent.
      const signed = await hostd.signRelease(runId, url);
      if (signed.sha !== run.sha || signed.version !== run.version || signed.sha256 !== run.sha256 || signed.repo.toLowerCase() !== source.toLowerCase()) {
        throw new Stop(`hostd signed ${signed.repo}@${signed.sha.slice(0, 7)} ${signed.version}, which is not this run's ${source}@${sha7} ${run.version}; cut the release again`);
      }

      // 5. The manifest.
      const manifestBytes = Buffer.byteLength(signed.asset);
      const manifest = await targetApi.uploadReleaseAsset(releaseRepo, draft.id, manifestName, signed.asset, manifestBytes, 'application/json');
      if (manifest.state !== 'uploaded' || manifest.size !== manifestBytes || manifest.name !== manifestName) {
        throw new Stop(`GitHub holds the manifest as ${manifest.name} (${manifest.state}, ${manifest.size} bytes), not ${manifestName} with ${manifestBytes}; cut the release again`);
      }

      // 6. The tag, on the pinned SHA: never the default branch's head now.
      if (!preflight.tagOnSha) {
        try {
          await sourceApi.request('POST', `/repos/${source}/git/refs`, { ref: `refs/tags/${tag}`, sha: run.sha });
        } catch (error) {
          if (status(error) === 422 && /rule/i.test(String((error as Error).message))) {
            throw new Stop(`a tag ruleset of ${source} refused ${tag}: ${githubSaid(error)}. Add OpenADLC's app as a bypass actor of the ruleset, set to Always, then cut the release again`);
          }
          throw error;
        }
        left.tagged = true;
        await releaseRuns.markTagged(runId);
      }
      if (separate && !preflight.releaseTagExists) {
        // A release needs a tag in its own repository; the built commit is not there.
        const head = await targetApi.request<{ object: { sha: string } }>('GET', `/repos/${releaseRepo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
        await targetApi.request('POST', `/repos/${releaseRepo}/git/refs`, { ref: `refs/tags/${tag}`, sha: head.object.sha });
        left.releaseTagged = true;
      }

      // 7. Published.
      left.public = true;
      await targetApi.request('PATCH', `/repos/${releaseRepo}/releases/${draft.id}`, { draft: false, make_latest: 'true' });

      // 8. Read back: what GitHub published is what was signed.
      const read = await targetApi.request<GitHubRelease>('GET', `/repos/${releaseRepo}/releases/${draft.id}`);
      const theirs = read.assets?.find((asset) => asset.name === uploaded.name);
      const problem =
        read.draft !== false
          ? 'GitHub still holds it as a draft'
          : read.tag_name !== tag
            ? `GitHub published it as ${read.tag_name}, not ${tag}`
            : !theirs
              ? `GitHub’s published release has no ${uploaded.name}`
              : theirs.browser_download_url !== url
                ? `GitHub published ${theirs.browser_download_url}, not the signed ${url}`
                : !read.assets?.some((asset) => asset.name === manifestName)
                  ? `GitHub’s published release has no ${manifestName}`
                  : null;
      if (problem) {
        try {
          await targetApi.request('PATCH', `/repos/${releaseRepo}/releases/${draft.id}`, { draft: true });
          left.public = false;
        } catch (error) {
          left.leftPublic = true;
          throw new Stop(
            `${problem}. Taking it back to a draft failed (${said(error)}), so the release at ${read.html_url} is public with a URL its manifest does not sign: delete it there`,
          );
        }
        throw new Stop(problem);
      }

      const done = await releaseRuns.published(runId, { releaseUrl: read.html_url, assetUrl: url });
      await hostd.deleteReleaseArtifact(runId).catch((error: unknown) => {
        this.warn(`[bridge] release ${tag} of ${source} is published, but hostd kept its artifact: ${error instanceof Error ? error.message : error}. Its 14-day sweep removes it`);
      });
      return done;
    } catch (error) {
      return fail(await this.cleanUp(said(error), { releaseRepo, source, tag, sha7, api: targetApi, ...left }));
    }
  }

  /**
   * Ends a `publishing` row that no publisher holds, as after the bridge
   * restarted mid-publish: its draft is deleted where it is still one, and the
   * reason names what was left.
   */
  async abandon(run: ReleaseRun): Promise<ReleaseRun | null> {
    if (run.state !== 'publishing') return null;
    const releaseRepo = run.releaseRepo ?? run.repoFullName;
    const tag = run.tag ?? `v${run.version ?? ''}`;
    const api = await this.deps.app(releaseRepo).catch(() => null);
    let draft: GitHubRelease | null = null;
    let isPublic = false;
    if (run.releaseId !== null && api) {
      const read = await api.request<GitHubRelease>('GET', `/repos/${releaseRepo}/releases/${run.releaseId}`).catch((error: unknown) => (status(error) === 404 ? null : undefined));
      if (read) {
        draft = read;
        isPublic = read.draft === false;
      } else if (read === undefined) {
        draft = { id: run.releaseId, tag_name: tag, draft: true, html_url: `https://github.com/${releaseRepo}/releases` };
      }
    } else if (run.releaseId !== null) {
      draft = { id: run.releaseId, tag_name: tag, draft: true, html_url: `https://github.com/${releaseRepo}/releases` };
    }
    const reason = isPublic
      ? `the bridge restarted while publishing, after GitHub made ${tag} public at ${draft?.html_url} but before its download URL was checked against the signed one. Check that its manifest's url is the artifact's download URL, or delete the release there and cut it again`
      : await this.cleanUp('the bridge restarted while publishing', {
          releaseRepo,
          source: run.repoFullName,
          tag,
          sha7: run.sha.slice(0, 7),
          api,
          draft,
          tagged: run.tagged,
          releaseTagged: false,
          public: false,
          leftPublic: false,
        });
    const parts = [isPublic && run.tagged ? `${reason}. ${tagLeft(run.repoFullName, tag, run.sha.slice(0, 7))}` : reason];
    // The release repository's own tag comes after the source's and is not
    // on the row, so a restart cannot know whether it was made: say it may be.
    if (run.tagged && releaseRepo.toLowerCase() !== run.repoFullName.toLowerCase()) {
      parts.push(`${tag} may also have been made on ${releaseRepo}'s default branch; a later cut reuses it, or delete it at https://github.com/${releaseRepo}/tags if the version is raised`);
    }
    return releaseRuns.publishFailed(run.runId, parts.join('. '));
  }

  private async preflight(run: ReleaseRun, tag: string, source: string, releaseRepo: string, separate: boolean): Promise<Preflight> {
    const sourceApi = await this.deps.app(source).catch(() => null);
    if (!sourceApi) throw new Stop(`OpenADLC's app is not installed on ${source}, or cannot be asked: install it there, then cut the release again`);
    const targetApi = separate ? await this.deps.app(releaseRepo).catch(() => null) : sourceApi;
    if (!targetApi) throw new Stop(`OpenADLC's app is not installed on ${releaseRepo}, where releases of ${source} are published: install it there, then cut the release again`);

    const repo = await targetApi.request<{ full_name: string; default_branch: string }>('GET', `/repos/${releaseRepo}`);

    for (const [api, name] of separate ? ([[sourceApi, source], [targetApi, releaseRepo]] as const) : ([[sourceApi, source]] as const)) {
      const found = await tagCreationBlockers(api, name, tag);
      const block = found.blocked[0];
      if (block) throw new Stop(`${tagBlockedDetail(block, tag, source)} (${rulesetSettingsUrl(block, name)})`);
      const unknown = found.unknown[0];
      if (unknown) {
        throw new Stop(
          `GitHub did not say whether OpenADLC's app may bypass the tag ruleset “${unknown.name}” of ${name}, which covers ${tag}. Add the app as a bypass actor, set to Always (${rulesetSettingsUrl(unknown, name)}), then cut the release again`,
        );
      }
    }

    const onSource = await tagCommit(sourceApi, source, tag);
    if (onSource !== null && onSource !== run.sha) {
      throw new Stop(`${tag} is already on ${onSource.slice(0, 7)} in ${source}; raise the version in ${run.versionFile}`);
    }
    const releaseTagExists = separate ? (await tagCommit(targetApi, releaseRepo, tag)) !== null : onSource !== null;

    const existing = await targetApi.request<GitHubRelease>('GET', `/repos/${releaseRepo}/releases/tags/${encodeURIComponent(tag)}`).catch((error: unknown) => {
      if (status(error) === 404) return null;
      throw error;
    });
    if (existing && existing.draft === false) throw new Stop(`a release ${tag} is already published at ${existing.html_url}; raise the version in ${run.versionFile}`);

    return { sourceApi, targetApi, fullName: repo.full_name, defaultBranch: repo.default_branch, tagOnSha: onSource === run.sha, releaseTagExists };
  }

  /** Takes back what a failed publish left where it can, and says what is left and what to do. */
  private async cleanUp(
    why: string,
    left: {
      releaseRepo: string;
      source: string;
      tag: string;
      sha7: string;
      api: PublishApi | null;
      draft: GitHubRelease | null;
      tagged: boolean;
      releaseTagged: boolean;
      public: boolean;
      leftPublic: boolean;
    },
  ): Promise<string> {
    const parts = [why];
    // A release left public is named in `why`, with what to do; deleting it
    // here would take a public release away without the person deciding.
    if (left.draft && !left.leftPublic) {
      // Once the publish was asked for, a failure after it (the read-back, a
      // timeout on a PATCH that applied) may come from a release that is
      // live, whose `published` delivery may already have moved cards to
      // Done. Only one GitHub still holds as a draft is deleted.
      let draft: GitHubRelease | null = left.draft;
      let mayBePublic = false;
      if (left.public) {
        const read = left.api
          ? await left.api.request<GitHubRelease>('GET', `/repos/${left.releaseRepo}/releases/${left.draft.id}`).catch((error: unknown) => (status(error) === 404 ? null : undefined))
          : undefined;
        if (read === null) draft = null;
        else if (read === undefined || read.draft !== true) {
          mayBePublic = true;
          if (read) draft = read;
        }
      }
      if (draft && mayBePublic) {
        parts.push(`The release at ${draft.html_url} may be public, so it was not deleted: check that its manifest's url is the artifact's download URL, or delete it there`);
      } else if (draft) {
        const deleted = left.api
          ? await left.api.request('DELETE', `/repos/${left.releaseRepo}/releases/${draft.id}`).then(
              () => true,
              (error: unknown) => status(error) === 404,
            )
          : false;
        if (!deleted) parts.push(`The draft release at ${draft.html_url} could not be deleted: delete it there`);
      }
    }
    if (left.tagged) parts.push(tagLeft(left.source, left.tag, left.sha7));
    if (left.releaseTagged) parts.push(`${left.tag} was also made on ${left.releaseRepo}'s default branch; delete it at https://github.com/${left.releaseRepo}/tags if the version is raised`);
    if (!left.tagged && !left.draft) parts.push('Nothing was tagged or published');
    return parts.join('. ');
  }
}

interface Preflight {
  sourceApi: PublishApi;
  targetApi: PublishApi;
  /** The release repository's canonical `owner/name`, as GitHub spells it in its download URLs. */
  fullName: string;
  defaultBranch: string;
  /** The tag is already on the pinned SHA: a retry after a failure past the tag reuses it. */
  tagOnSha: boolean;
  releaseTagExists: boolean;
}

/** What the reason says of a tag a failure leaves on the pinned commit. */
function tagLeft(source: string, tag: string, sha7: string): string {
  return `${tag} is on ${sha7} in ${source}. Cutting the same commit again reuses it. To build another commit, raise the version, or delete the tag at https://github.com/${source}/tags`;
}

/** The commit a tag is on, through an annotated tag's object; null when there is no such tag. */
async function tagCommit(api: PublishApi, repo: string, tag: string): Promise<string | null> {
  const ref = await api.request<{ object: { sha: string; type: string } } | { object: { sha: string; type: string } }[]>('GET', `/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`).catch(
    (error: unknown) => {
      if (status(error) === 404) return null;
      throw error;
    },
  );
  // GitHub answers a list when the name is only a prefix of tags: no such tag.
  if (!ref || Array.isArray(ref)) return null;
  if (ref.object.type !== 'tag') return ref.object.sha;
  const annotated = await api.request<{ object: { sha: string } }>('GET', `/repos/${repo}/git/tags/${ref.object.sha}`);
  return annotated.object.sha;
}
