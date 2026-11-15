import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELEASE_TAG,
  ReleaseManifestError,
  releaseManifestAsset,
  releaseMessage,
  releaseTagProblem,
  type ReleaseFields,
} from './release-manifest.js';

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const FIELDS: ReleaseFields = { version: '1.2.3', sha256: SHA, url: 'https://example.com/a.zip' };

function refusal(run: () => unknown): ReleaseManifestError {
  try {
    run();
  } catch (error) {
    if (error instanceof ReleaseManifestError) return error;
    throw error;
  }
  throw new Error('it was not refused');
}

describe('the signed message', () => {
  it('is the tag and the three values, each ended by one LF, and nothing else', () => {
    const bytes = releaseMessage(DEFAULT_RELEASE_TAG, FIELDS);
    const expected = Buffer.from(`openadlc-release-manifest-1\n1.2.3\n${SHA}\nhttps://example.com/a.zip\n`, 'utf8');
    expect(Buffer.from(bytes).equals(expected)).toBe(true);
    // No BOM, no CR, ends in LF.
    expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    expect(bytes.filter((byte) => byte === 0x0a).length).toBe(4);
  });

  it('carries a repository’s own tag on its first line', () => {
    const text = new TextDecoder().decode(releaseMessage('acme-widget-updates v1', FIELDS));
    expect(text.split('\n')[0]).toBe('acme-widget-updates v1');
  });

  it.each([
    ['a version with an LF', { version: '1.2\n3' }, 'version'],
    ['a version with a space', { version: '1.2 3' }, 'version'],
    ['a version longer than 64', { version: '1'.repeat(65) }, 'version'],
    ['an empty version', { version: '' }, 'version'],
    ['a sha256 in uppercase', { sha256: SHA.toUpperCase() }, 'sha256'],
    ['a sha256 of 63 characters', { sha256: SHA.slice(1) }, 'sha256'],
    ['a sha256 with an LF', { sha256: `${SHA.slice(1)}\n` }, 'sha256'],
    ['an http url', { url: 'http://example.com/a.zip' }, 'url'],
    ['a url with a space', { url: 'https://example.com/a b.zip' }, 'url'],
    ['a url with an LF', { url: 'https://example.com/a.zip\nhttps://evil.test/' }, 'url'],
    ['a url the parser rewrites', { url: 'https://Example.com/a.zip' }, 'url'],
    ['a url with a default port', { url: 'https://example.com:443/a.zip' }, 'url'],
    ['a relative url', { url: '/a.zip' }, 'url'],
    ['a url over 2048 characters', { url: `https://example.com/${'a'.repeat(2048)}` }, 'url'],
  ] as const)('refuses %s, naming the field', (_, change, field) => {
    const error = refusal(() => releaseMessage(DEFAULT_RELEASE_TAG, { ...FIELDS, ...change }));
    expect(error.field).toBe(field);
    expect(error.message).toContain(field === 'sha256' ? 'sha256' : field);
  });

  it.each([
    ['an LF', 'tag\nversion'],
    ['a CR', 'tag\r'],
    ['a tab', 'a\tb'],
    ['a C1 control', 'a\u0085b'],
    ['a leading space', ' tag'],
    ['nothing', ''],
    ['more than 256 bytes', 'é'.repeat(129)],
  ])('refuses a tag with %s', (_, tag) => {
    expect(releaseTagProblem(tag)).not.toBeNull();
    expect(refusal(() => releaseMessage(tag, FIELDS)).field).toBe('tag');
  });

  it('takes the default tag and a tag with spaces inside it', () => {
    expect(releaseTagProblem(DEFAULT_RELEASE_TAG)).toBeNull();
    expect(releaseTagProblem('my app updates 2')).toBeNull();
  });
});

describe('the manifest asset', () => {
  it('is version, url, sha256 and sig, in that order, as strings, and one LF', () => {
    const asset = releaseManifestAsset(FIELDS, 'c2ln');
    expect(asset.endsWith('}\n')).toBe(true);
    expect(asset.indexOf('\n')).toBe(asset.length - 1);
    const parsed = JSON.parse(asset) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['version', 'url', 'sha256', 'sig']);
    expect(parsed).toEqual({ version: '1.2.3', url: FIELDS.url, sha256: SHA, sig: 'c2ln' });
  });
});
