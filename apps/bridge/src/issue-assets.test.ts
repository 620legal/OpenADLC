import { describe, expect, it, vi } from 'vitest';
import { allowedAssetUrl, assetLinks, collectIssueAssets, downloadAsset, stableUrl } from './issue-assets.js';

/**
 * Images in an issue, kept with its work item: only GitHub's own image hosts,
 * redirects only among them, only from people OpenADLC acts for, and each
 * link once however often its signature changes.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const SIGNED = 'https://private-user-images.githubusercontent.com/1/9f2c-mockup.png?jwt=one';

describe('which links are images to read', () => {
  it('are GitHub’s image hosts over https, and on github.com only its attachments', () => {
    expect(allowedAssetUrl(SIGNED)).toBe(true);
    expect(allowedAssetUrl('https://github.com/user-attachments/assets/9f2c')).toBe(true);
    expect(allowedAssetUrl('https://github.com/acme/api/settings')).toBe(false);
    expect(allowedAssetUrl('http://private-user-images.githubusercontent.com/1/x.png')).toBe(false);
    expect(allowedAssetUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(allowedAssetUrl('https://private-user-images.githubusercontent.com.evil.test/x.png')).toBe(false);
    expect(allowedAssetUrl('https://user:pw@objects.githubusercontent.com/x')).toBe(false);
  });

  it('are found in rendered HTML, each once, with their words', () => {
    // GitHub writes a link's query separators as &amp;; read raw, the signature is wrong.
    const signed = `${SIGNED}&X-Amz-Date=20261002`;
    const html = `<p><img src="${signed.replaceAll('&', '&amp;')}" alt="the header&#39;s mockup"></p><a href="https://example.test/x.png">x</a><img src="${signed}">`;
    expect(assetLinks(html)).toEqual([{ url: signed, alt: "the header's mockup" }]);
  });

  it('are known by their address without the signature, which changes every read', () => {
    expect(stableUrl(SIGNED)).toBe('https://private-user-images.githubusercontent.com/1/9f2c-mockup.png');
  });
});

describe('downloading one', () => {
  it('follows a redirect only to another image host', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).startsWith('https://github.com/')
        ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/internal' } })
        : new Response(PNG),
    ) as unknown as typeof fetch;
    await expect(downloadAsset('https://github.com/user-attachments/assets/9f2c', fetchImpl)).rejects.toThrow(/not one of GitHub's image hosts|Invalid URL/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('reading an issue’s images into its item', () => {
  function world() {
    const kept = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    const store = {
      sourceUrlsOn: vi.fn(async () => new Set(kept)),
      listForSubjects: vi.fn(async () => rows.map(() => ({ sizeBytes: PNG.length })) as never),
      storeFromGitHub: vi.fn(async (input: Record<string, unknown>) => {
        kept.add(String(input.sourceUrl));
        rows.push(input);
        return { name: String(input.name) } as never;
      }),
    };
    const client = {
      getIssueHtml: vi.fn(async () => ({ bodyHtml: `<img src="${SIGNED}" alt="header mockup">`, user: 'janedoe', association: 'OWNER' })),
      listCommentsHtml: vi.fn(async () => [{ user: 'stranger', bodyHtml: '<img src="https://private-user-images.githubusercontent.com/2/evil.png?jwt=x">', association: 'NONE' }]),
    };
    const fetchImpl = vi.fn(async () => new Response(PNG)) as unknown as typeof fetch;
    return { store, client, fetchImpl, rows };
  }

  it('keeps the images of people OpenADLC acts for, on the issue, and only once', async () => {
    const { store, client, fetchImpl, rows } = world();
    const read = (signature: string) =>
      collectIssueAssets({
        client: { ...client, getIssueHtml: vi.fn(async () => ({ bodyHtml: `<img src="${SIGNED.replace('one', signature)}" alt="header mockup">`, user: 'janedoe', association: 'OWNER' })) } as never,
        repoFullName: 'acme/api',
        number: 12,
        subjectRef: 'api#12',
        repoId: 'repo-1',
        itemSubjects: ['request:a4b02784', 'api#12'],
        heard: async (author) => author.association === 'OWNER',
        fetchImpl,
        store: store as never,
      });

    expect(await read('one')).toEqual({ stored: ['header-mockup.png'], skipped: [] });
    expect(rows[0]).toMatchObject({ subjectRef: 'api#12', sourceUrl: 'https://private-user-images.githubusercontent.com/1/9f2c-mockup.png', uploadedBy: 'janedoe', mediaType: 'image/png' });
    // The stranger's image was never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Read again with a fresh signature: recognised, and not downloaded again.
    expect(await read('two')).toEqual({ stored: [], skipped: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
