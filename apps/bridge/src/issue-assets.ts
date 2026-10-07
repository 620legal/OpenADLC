import { createHash } from 'node:crypto';
import { attachments as attachmentStore } from '@fleetadlc/db';
import type { GitHubClient } from '@fleetadlc/github';
import { ATTACHMENT_LIMITS, ATTACHMENT_TYPES, checkAttachment, itemRoomFor, safeFileName } from '@fleetadlc/shared';

/**
 * Images written into an issue on GitHub — a screenshot pasted into the
 * description, a mockup in a comment — read once and kept with the work item,
 * so intake, design and the build see what the person showed rather than a
 * link they cannot open: a pasted image in a private repository answers only a
 * signed-in browser.
 *
 * GitHub renders such an image, in an issue's HTML, as a short-lived signed
 * `private-user-images` link that answers whoever holds it. That is what is
 * downloaded, and only:
 *
 * - from the body and the comments of people OpenADLC acts for, as everything
 *   a bot reads is (`actsFor`): anybody can comment on a public repository,
 *   and an image is an instruction as much as text is;
 * - from GitHub's own image hosts, following a redirect only to another of
 *   them, so a link in an issue cannot make the bridge fetch an address on its
 *   own network or anyone else's;
 * - under the same limits and checks as a file given in the console, and once:
 *   a link already kept, or the same bytes, is not stored again.
 *
 * Triage still may not run `curl`: the bridge fetches, the task reads the file.
 */

/** The hosts an image in an issue is served from, and where those redirect. */
export const ASSET_HOSTS: readonly string[] = [
  'github.com',
  'private-user-images.githubusercontent.com',
  'user-images.githubusercontent.com',
  'objects.githubusercontent.com',
];

/** How many redirects a download follows, each to an allowed host. */
const MAX_REDIRECTS = 4;

/** Whether a link is one of GitHub's image links: https, an allowed host, and on github.com only its attachments. */
export function allowedAssetUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  if (!ASSET_HOSTS.includes(host)) return false;
  return host !== 'github.com' || url.pathname.startsWith('/user-attachments/');
}

/** A link's address without its signature: what a link is recognised by when it is read again. */
export function stableUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function unescape(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** The image links in rendered HTML, each once, with the words GitHub gave them. */
export function assetLinks(html: string): { url: string; alt: string | null }[] {
  const found = new Map<string, string | null>();
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = /\bsrc="([^"]+)"/i.exec(tag)?.[1];
    if (!src) continue;
    const url = unescape(src);
    if (!allowedAssetUrl(url)) continue;
    const alt = /\balt="([^"]*)"/i.exec(tag)?.[1];
    if (!found.has(url)) found.set(url, alt ? unescape(alt) : null);
  }
  // A file attached to an issue that is not an image (a PDF) is a link.
  for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([^<]*)<\/a>/gi)) {
    const url = unescape(match[1]!);
    if (!allowedAssetUrl(url) || found.has(url)) continue;
    found.set(url, match[2]?.trim() || null);
  }
  return [...found.entries()].map(([url, alt]) => ({ url, alt }));
}

/**
 * Downloads one link, following a redirect only to another allowed host, and
 * stopping at the file limit as the bytes arrive.
 */
export async function downloadAsset(start: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!allowedAssetUrl(url)) throw new Error(`${new URL(url).hostname} is not one of GitHub's image hosts`);
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (!next) throw new Error('a redirect that names nowhere');
      url = new URL(next, url).toString();
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`GitHub answered ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > ATTACHMENT_LIMITS.fileBytes) throw new Error('larger than a file may be');
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > ATTACHMENT_LIMITS.fileBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('larger than a file may be');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('too many redirects');
}

export interface IssueAssetsInput {
  client: Pick<GitHubClient, 'getIssueHtml' | 'listCommentsHtml'>;
  repoFullName: string;
  number: number;
  subjectRef: string;
  repoId: string | null;
  /** Every subject of the item, for its limits. */
  itemSubjects: readonly string[];
  /** Whether OpenADLC acts for an author: only their images are read. */
  heard: (author: { user: string; association: string | null }) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  store?: Pick<typeof attachmentStore, 'sourceUrlsOn' | 'storeFromGitHub' | 'listForSubjects'>;
}

/** Reads the images in an issue into its work item; what was kept, and what was not and why. */
export async function collectIssueAssets(input: IssueAssetsInput): Promise<{ stored: string[]; skipped: string[] }> {
  const store = input.store ?? attachmentStore;
  const [issue, comments] = await Promise.all([
    input.client.getIssueHtml(input.repoFullName, input.number),
    input.client.listCommentsHtml(input.repoFullName, input.number).catch(() => []),
  ]);
  const posts = [{ user: issue.user, association: issue.association, bodyHtml: issue.bodyHtml }, ...comments];

  const links: { url: string; alt: string | null; user: string }[] = [];
  for (const post of posts) {
    if (!(await input.heard(post).catch(() => false))) continue;
    for (const link of assetLinks(post.bodyHtml)) links.push({ ...link, user: post.user });
  }
  if (links.length === 0) return { stored: [], skipped: [] };

  const kept = await store.sourceUrlsOn(input.subjectRef);
  const used = await store.listForSubjects(input.itemSubjects);
  let room = { count: used.length, bytes: used.reduce((total, one) => total + one.sizeBytes, 0) };
  const stored: string[] = [];
  const skipped: string[] = [];

  for (const link of links) {
    const source = stableUrl(link.url);
    if (kept.has(source)) continue;
    let bytes: Buffer;
    try {
      bytes = await downloadAsset(link.url, input.fetchImpl);
    } catch (error) {
      skipped.push(`${source}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const base = (link.alt && !/^image$/i.test(link.alt) ? link.alt : source.split('/').pop()) ?? 'image';
    const checked = checkAttachment({ name: base, bytes });
    if (!checked.ok) {
      skipped.push(`${source}: ${checked.reason}`);
      continue;
    }
    const full = itemRoomFor(room, { count: 1, bytes: bytes.length });
    if (full) {
      skipped.push(`${source}: ${full}`);
      break;
    }
    const extension = ATTACHMENT_TYPES[checked.mediaType] ?? 'bin';
    const named = safeFileName(base, checked.mediaType).replace(/\.[A-Za-z0-9]+$/, '');
    const row = await store.storeFromGitHub({
      subjectRef: input.subjectRef,
      repoId: input.repoId,
      sourceUrl: source,
      name: `${named}.${extension}`,
      mediaType: checked.mediaType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content: bytes,
      uploadedBy: link.user,
    });
    kept.add(source);
    if (row) {
      stored.push(row.name);
      room = { count: room.count + 1, bytes: room.bytes + bytes.length };
    }
  }
  return { stored, skipped };
}
