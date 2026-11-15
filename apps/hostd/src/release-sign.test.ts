import { execFileSync, spawnSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseSigningKeyRef, serializeReleaseKeyRecord, type SecretStore } from '@openadlc/github';
import { DEFAULT_RELEASE_TAG, ReleaseManifestError, type ReleaseFields } from '@openadlc/shared';
import { signRelease } from './release-sign.js';

/**
 * The fixed vector (ADR 0069): RFC 8032 §7.1 test 1's key over a fixed
 * message. Ed25519 is deterministic, so the signature is a constant, and a
 * change to the layout, the encoding or the key handling changes it.
 */
const SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const SEED_BASE64 = Buffer.from(SEED_HEX, 'hex').toString('base64');
/** The public key RFC 8032 prints for that seed: taken from the RFC, not derived here. */
const RFC_PUBLIC_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const PEM_BODY = 'MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g';
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----\n`;
const SIGNATURE = 'DVMxXeRNqth5OaIRXlqbHJsOHeatH+Dw+waqyqAXVc8jTljdW66V928RNYKr2MwknT1xees4HQ3jhGei/djRDw==';

const REPO = 'acme/widget.app';
const FIELDS: ReleaseFields = {
  version: '1.2.3',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  url: 'https://example.com/releases/1.2.3/app.zip',
};

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
  async list(prefix = ''): Promise<string[]> {
    return [...this.values.keys()].filter((ref) => ref.startsWith(prefix)).sort();
  }
}

function storeWith(record: { repo?: string; tag?: string; key?: string } = {}): MemoryStore {
  const store = new MemoryStore();
  store.values.set(
    releaseSigningKeyRef(REPO),
    serializeReleaseKeyRecord({ v: 1, repo: record.repo ?? REPO, tag: record.tag ?? DEFAULT_RELEASE_TAG, key: record.key ?? PEM }),
  );
  return store;
}

function rfcPublicKey() {
  // SPKI DER for ed25519: a fixed 12-byte header, then the raw key.
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(RFC_PUBLIC_HEX, 'hex')]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

describe('signing a release', () => {
  it('gives the fixed vector’s signature, which checks against RFC 8032’s public key', async () => {
    const signed = await signRelease(REPO, FIELDS, storeWith());
    expect(signed.sig).toBe(SIGNATURE);
    expect(signed.sig).toHaveLength(88);
    expect(Buffer.from(signed.publicKey, 'base64').toString('hex')).toBe(RFC_PUBLIC_HEX);
    expect(Buffer.from(signed.message).toString('utf8')).toBe(
      `${DEFAULT_RELEASE_TAG}\n${FIELDS.version}\n${FIELDS.sha256}\n${FIELDS.url}\n`,
    );
    expect(verify(null, signed.message, rfcPublicKey(), Buffer.from(signed.sig, 'base64'))).toBe(true);
    expect(JSON.parse(signed.asset)).toEqual({ ...FIELDS, sig: SIGNATURE });
  });

  it('finds the key in other capitals of the repository’s name', async () => {
    expect((await signRelease('Acme/Widget.App', FIELDS, storeWith())).sig).toBe(SIGNATURE);
  });

  it('signs over the tag filed with the key, so a client pinning another tag fails', async () => {
    const signed = await signRelease(REPO, FIELDS, storeWith({ tag: 'acme-updates' }));
    expect(new TextDecoder().decode(signed.message).split('\n')[0]).toBe('acme-updates');
    expect(signed.sig).not.toBe(SIGNATURE);
    const pinnedDefault = Buffer.from(`${DEFAULT_RELEASE_TAG}\n${FIELDS.version}\n${FIELDS.sha256}\n${FIELDS.url}\n`);
    expect(verify(null, pinnedDefault, rfcPublicKey(), Buffer.from(signed.sig, 'base64'))).toBe(false);
  });

  it('refuses a value that breaks the layout before the key is read', async () => {
    // The record's key is garbage: reaching it would be a different error.
    const store = storeWith({ key: 'not a key' });
    await expect(signRelease(REPO, { ...FIELDS, url: 'http://example.com/a.zip' }, store)).rejects.toBeInstanceOf(ReleaseManifestError);
    await expect(signRelease(REPO, { ...FIELDS, sha256: FIELDS.sha256.toUpperCase() }, store)).rejects.toBeInstanceOf(
      ReleaseManifestError,
    );
    await expect(signRelease(REPO, { ...FIELDS, version: '1\n2' }, store)).rejects.toBeInstanceOf(ReleaseManifestError);
  });

  it('says what to run when there is no key, or the one filed cannot be used', async () => {
    await expect(signRelease(REPO, FIELDS, new MemoryStore())).rejects.toThrow(
      `no release signing key for ${REPO}. Run on the host: openadlc release-key import --repo ${REPO} --file <path>`,
    );
    const unreadable = new MemoryStore();
    unreadable.values.set(releaseSigningKeyRef(REPO), '{not json');
    await expect(signRelease(REPO, FIELDS, unreadable)).rejects.toThrow('--replace');
    await expect(signRelease(REPO, FIELDS, storeWith({ repo: 'acme/other' }))).rejects.toThrow(/names another repository.*--replace/);
    await expect(signRelease(REPO, FIELDS, storeWith({ key: 'not a key' }))).rejects.toThrow(/not a private key.*--replace/);
  });
});

/**
 * The signature as a client outside OpenADLC checks it: `pkeyutl -rawin`,
 * which OpenSSL has from 3.0 on, over the exact bytes. LibreSSL (macOS's
 * `openssl`) and OpenSSL 1.1 have no `-rawin` for ed25519, so there it is
 * skipped by name. Gated on the major version rather than on "OpenSSL 3", which
 * skipped it on a host with Homebrew's OpenSSL 4.
 */
const opensslVersion = (() => {
  const run = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : '';
})();

/** Whether `openssl version` names OpenSSL 3 or later: the ones with `pkeyutl -rawin`. */
function hasRawin(version: string): boolean {
  const major = /^OpenSSL (\d+)\./.exec(version);
  return major !== null && Number(major[1]) >= 3;
}

describe('which openssl runs the independent check', () => {
  it.each([
    ['OpenSSL 3.0.13 30 Jan 2024', true],
    ['OpenSSL 4.0.3 1 Oct 2026', true],
    ['OpenSSL 1.1.1w  11 Sep 2023', false],
    ['LibreSSL 3.3.6', false],
    ['', false],
  ])('%s: %s', (version, runs) => {
    expect(hasRawin(version)).toBe(runs);
  });
});

describe('the signature, checked by OpenSSL', () => {
  it.skipIf(!hasRawin(opensslVersion))(
    `verifies with openssl pkeyutl -verify -rawin (skipped without OpenSSL 3 or later; this host has ${opensslVersion || 'no openssl'})`,
    async () => {
      const signed = await signRelease(REPO, FIELDS, storeWith());
      const dir = mkdtempSync(join(tmpdir(), 'release-sign-'));
      try {
        writeFileSync(join(dir, 'pub.pem'), rfcPublicKey().export({ type: 'spki', format: 'pem' }));
        writeFileSync(join(dir, 'message'), signed.message);
        writeFileSync(join(dir, 'sig.bin'), Buffer.from(signed.sig, 'base64'));
        const run = (message: string) =>
          spawnSync(
            'openssl',
            ['pkeyutl', '-verify', '-pubin', '-rawin', '-inkey', join(dir, 'pub.pem'), '-in', join(dir, message), '-sigfile', join(dir, 'sig.bin')],
            { encoding: 'utf8' },
          );
        const good = run('message');
        expect(good.status, good.stderr).toBe(0);
        expect(good.stdout).toContain('Signature Verified Successfully');
        // One byte more, the trailing LF doubled, and it fails.
        writeFileSync(join(dir, 'longer'), Buffer.concat([Buffer.from(signed.message), Buffer.from('\n')]));
        expect(run('longer').status).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('the key never leaves the signing step', () => {
  const secrets = [SEED_HEX, SEED_BASE64, PEM_BODY];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is in no log, output, error or environment, signing or refusing', async () => {
    const said: string[] = [];
    const keep = (...args: unknown[]) => {
      said.push(args.map(String).join(' '));
    };
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(keep);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      said.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      said.push(String(chunk));
      return true;
    });
    const envBefore = { ...process.env };

    const signed = await signRelease(REPO, FIELDS, storeWith());
    said.push(JSON.stringify({ ...signed, message: Buffer.from(signed.message).toString('utf8') }));
    for (const attempt of [
      () => signRelease(REPO, { ...FIELDS, url: 'http://x.test/' }, storeWith()),
      () => signRelease(REPO, FIELDS, storeWith({ repo: 'acme/other' })),
      () => signRelease(REPO, FIELDS, storeWith({ key: PEM.replace('MC4C', 'MC4D') })),
      () => signRelease(REPO, FIELDS, new MemoryStore()),
    ]) {
      const error = await attempt().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      said.push(String((error as Error).message), String((error as Error).stack));
    }

    vi.restoreAllMocks();
    expect(process.env).toEqual(envBefore);
    const everything = [...said, ...Object.values(process.env).map(String)].join('\n');
    for (const secret of secrets) expect(everything).not.toContain(secret);
  });

  it('is named by ref in three files only, and told apart in those and the backup', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, '..', '..', '..');
    const files = execFileSync('git', ['ls-files', '--', 'apps', 'packages'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'));
    expect(files.length).toBeGreaterThan(100);

    const naming = (name: string) =>
      files.filter((file) => new RegExp(`\\b${name}\\b`).test(readFileSync(join(root, file), 'utf8'))).sort();

    const keyFiles = ['apps/cli/src/commands/release-key.ts', 'apps/hostd/src/release-sign.ts', 'packages/github/src/secrets.ts'];
    expect(naming('releaseSigningKeyRef')).toEqual(keyFiles);
    expect(naming('isReleaseSigningKeyRef').filter((file) => !keyFiles.includes(file) && !file.startsWith('packages/backup/src/'))).toEqual(
      [],
    );
  });
});
