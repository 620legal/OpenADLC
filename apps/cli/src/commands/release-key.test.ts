import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReleaseKeyRecord, releaseSigningKeyRef, type SecretStore } from '@openadlc/github';
import { DEFAULT_RELEASE_TAG } from '@openadlc/shared';
import { openKeyFile, releaseKey, releaseKeyArgs, readReleaseKey, type ReleaseKeyDeps } from './release-key.js';

/** RFC 8032 §7.1 test 1's seed, as a PEM and as base64: one key in both forms. */
const SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const SEED_BASE64 = Buffer.from(SEED_HEX, 'hex').toString('base64');
const PEM_BODY = 'MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g';
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----\n`;
/** RFC 8032's public key for that seed, in base64. */
const PUBLIC_BASE64 = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64');

const other = generateKeyPairSync('ed25519');
const OTHER_PEM = String(other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const REPO = 'acme/widget.app';

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

let printed: string[];
let store: MemoryStore;
let files: Map<string, Buffer | 'directory'>;

function deps(): ReleaseKeyDeps {
  return {
    store,
    open: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return {
        stat: async () => ({ isFile: () => file !== 'directory', size: file === 'directory' ? 0 : file.length }),
        read: async (max) => {
          if (!(file instanceof Buffer)) throw new Error('EISDIR');
          return file.subarray(0, max);
        },
        close: async () => undefined,
      };
    },
  };
}

function file(path: string, contents: string | Buffer): string {
  files.set(path, Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8'));
  return path;
}

async function run(...argv: string[]): Promise<number> {
  return releaseKey(argv, deps());
}

function stored() {
  return parseReleaseKeyRecord(store.values.get(releaseSigningKeyRef(REPO)) ?? null);
}

beforeEach(() => {
  printed = [];
  store = new MemoryStore();
  files = new Map();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('importing a release key', () => {
  it('takes the PEM openssl writes and the base64 seed of the same key, and files one record', async () => {
    expect(await run('import', '--repo', REPO, '--file', file('/k.pem', PEM))).toBe(0);
    const fromPem = store.values.get(releaseSigningKeyRef(REPO));
    expect(stored()).toMatchObject({ v: 1, repo: REPO, tag: DEFAULT_RELEASE_TAG });
    expect(printed.join('\n')).toContain(PUBLIC_BASE64);

    store = new MemoryStore();
    expect(await run('import', '--repo', REPO, '--file', file('/k.b64', `${SEED_BASE64}\n`))).toBe(0);
    expect(store.values.get(releaseSigningKeyRef(REPO))).toBe(fromPem);
  });

  it('files the tag it is given with the key', async () => {
    expect(await run('import', '--repo', REPO, '--file', file('/k.pem', PEM), '--tag', 'acme-updates v1')).toBe(0);
    expect(stored()?.tag).toBe('acme-updates v1');
    expect(printed.join('\n')).toContain('tag: acme-updates v1');
  });

  it.each([
    ['an encrypted PEM', () => String(other.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' })), 'decrypt it first'],
    ['a public key', () => String(other.publicKey.export({ type: 'spki', format: 'pem' })), 'this is a public key'],
    ['an RSA key', () => String(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })), 'this is an rsa key'],
    ['a P-256 key', () => String(p256.privateKey.export({ type: 'pkcs8', format: 'pem' })), 'this is an ec key'],
    ['a 31-byte seed', () => Buffer.alloc(31, 7).toString('base64'), 'is 31 bytes; an ed25519 seed is exactly 32'],
    ['text that is not base64', () => 'hello, this is not a key', 'not a PKCS#8 PEM or a base64 32-byte ed25519 seed'],
    ['a broken PEM', () => PEM.replace('MC4C', '!!!!'), 'not a PKCS#8 PEM or a base64 32-byte ed25519 seed'],
  ])('refuses %s, saying what to do, and stores nothing', async (_, contents, says) => {
    expect(await run('import', '--repo', REPO, '--file', file('/k', contents()))).toBe(1);
    expect(printed.join('\n')).toContain(says);
    expect(store.values.size).toBe(0);
  });

  it('refuses an over-size file before reading it, a directory and a missing file', async () => {
    const read = vi.fn();
    files.set('/big', Buffer.alloc(16 * 1024 + 1, 0x41));
    const sized: ReleaseKeyDeps = {
      store,
      open: async () => ({ stat: async () => ({ isFile: () => true, size: 16 * 1024 + 1 }), read, close: async () => undefined }),
    };
    expect(await releaseKey(['import', '--repo', REPO, '--file', '/big'], sized)).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('too big to be an ed25519 key');

    files.set('/dir', 'directory');
    expect(await run('import', '--repo', REPO, '--file', '/dir')).toBe(1);
    expect(printed.join('\n')).toContain('not a regular file');

    expect(await run('import', '--repo', REPO, '--file', '/nowhere')).toBe(1);
    expect(printed.join('\n')).toContain('there is no file at /nowhere');
    expect(store.values.size).toBe(0);
  });

  it('checks and reads one open descriptor, and refuses a file that grew past the cap after its stat', async () => {
    const opened = vi.fn();
    const close = vi.fn(async () => undefined);
    const grown: ReleaseKeyDeps = {
      store,
      open: async (path) => {
        opened(path);
        return {
          stat: async () => ({ isFile: () => true, size: 10 }),
          read: async (max) => Buffer.alloc(max, 0x41),
          close,
        };
      },
    };
    expect(await releaseKey(['import', '--repo', REPO, '--file', '/grown'], grown)).toBe(1);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(printed.join('\n')).toContain('too big to be an ed25519 key');
    expect(store.values.size).toBe(0);
  });

  it('refuses a tag with a line break, and a repository that is not OWNER/NAME', async () => {
    expect(await run('import', '--repo', REPO, '--file', file('/k.pem', PEM), '--tag', 'a\nb')).toBe(1);
    expect(await run('import', '--repo', 'acme', '--file', '/k.pem')).toBe(2);
    expect(await run('import', '--repo', 'acme/a b', '--file', '/k.pem')).toBe(2);
    expect(store.values.size).toBe(0);
  });

  it('refuses a flag or argument it does not take, so a typo of --tag never files the default', async () => {
    expect(releaseKeyArgs(['import', '--repo', REPO, '--file', '/k', '--tagg', 'x'])).toEqual({
      refusal: 'openadlc release-key import does not take --tagg; it takes --repo, --file, --tag, --replace',
    });
    expect(releaseKeyArgs(['import', '--repo', REPO, '--file', '/k', 'extra'])).toHaveProperty('refusal');
    expect(releaseKeyArgs(['import', '--repo', REPO, '--file'])).toEqual({ refusal: '--file needs a value' });
    expect(releaseKeyArgs(['import', '--repo', REPO, '--file', '/k', '--replace=yes'])).toEqual({ refusal: '--replace takes no value' });
    expect(releaseKeyArgs(['show', '--repo', REPO, '--replace'])).toHaveProperty('refusal');
    expect(releaseKeyArgs(['rotate', '--repo', REPO])).toHaveProperty('refusal');
    expect(releaseKeyArgs(['import', `--repo=${REPO}`, '--file=/k', '--tag=t=1', '--replace'])).toEqual({
      subcommand: 'import',
      repo: REPO,
      file: '/k',
      tag: 't=1',
      replace: true,
    });
    expect(await run('import', '--repo', REPO, '--file', file('/k', PEM), '--tagg', 'x')).toBe(2);
    expect(store.values.size).toBe(0);
  });
});

describe('the key file on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-key-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports a real file, and refuses a link to it without following the link', async () => {
    const real = join(dir, 'k.pem');
    writeFileSync(real, PEM);
    const link = join(dir, 'link.pem');
    symlinkSync(real, link);

    expect(await releaseKey(['import', '--repo', REPO, '--file', link], { store, open: openKeyFile })).toBe(1);
    expect(printed.join('\n')).toContain(`${link} is a link; give the key file itself`);
    expect(store.values.size).toBe(0);

    expect(await releaseKey(['import', '--repo', REPO, '--file', real], { store, open: openKeyFile })).toBe(0);
    expect(stored()).toMatchObject({ repo: REPO });
  });

  it('refuses a directory and a missing path', async () => {
    expect(await releaseKey(['import', '--repo', REPO, '--file', dir], { store, open: openKeyFile })).toBe(1);
    expect(printed.join('\n')).toContain('not a regular file');
    expect(await releaseKey(['import', '--repo', REPO, '--file', join(dir, 'nope')], { store, open: openKeyFile })).toBe(1);
    expect(printed.join('\n')).toContain('there is no file at');
    expect(store.values.size).toBe(0);
  });
});

describe('a second import', () => {
  beforeEach(async () => {
    expect(await run('import', '--repo', REPO, '--file', file('/k.pem', PEM))).toBe(0);
    printed = [];
  });

  it('of the same key and tag says it is already imported', async () => {
    const before = store.values.get(releaseSigningKeyRef(REPO));
    expect(await run('import', '--repo', REPO.toUpperCase(), '--file', file('/seed', SEED_BASE64))).toBe(0);
    expect(printed.join('\n')).toContain('already imported');
    expect(store.values.get(releaseSigningKeyRef(REPO))).toBe(before);
  });

  it.each([
    ['a different key', ['--file', '/other.pem']],
    ['the same key with a different tag', ['--file', '/k.pem', '--tag', 'acme-updates']],
  ])('of %s is refused without --replace, and written with it', async (_, flags) => {
    file('/other.pem', OTHER_PEM);
    const before = store.values.get(releaseSigningKeyRef(REPO));
    expect(await run('import', '--repo', REPO, ...flags)).toBe(1);
    const said = printed.join('\n');
    expect(said).toContain('already has a different release signing key or tag');
    expect(said).toContain(`public key ${PUBLIC_BASE64}`);
    expect(said).toContain('--replace');
    expect(store.values.get(releaseSigningKeyRef(REPO))).toBe(before);

    expect(await run('import', '--repo', REPO, ...flags, '--replace')).toBe(0);
    expect(store.values.get(releaseSigningKeyRef(REPO))).not.toBe(before);
  });
});

describe('showing a release key', () => {
  it('prints the public key and tag, or what to run when there is none', async () => {
    expect(await run('show', '--repo', REPO)).toBe(1);
    expect(printed.join('\n')).toContain(`openadlc release-key import --repo ${REPO} --file <path>`);

    await run('import', '--repo', REPO, '--file', file('/k.pem', PEM), '--tag', 'acme-updates');
    printed = [];
    expect(await run('show', '--repo', 'ACME/Widget.App')).toBe(0);
    const said = printed.join('\n');
    expect(said).toContain(PUBLIC_BASE64);
    expect(said).toContain('tag: acme-updates');
    expect(said).toContain('-----BEGIN PUBLIC KEY-----');
  });
});

describe('the key file’s contents', () => {
  it('appear in no output, error or environment, imported, shown or refused', async () => {
    const said: string[] = [];
    const keep = (...args: unknown[]) => {
      said.push(args.map(String).join(' '));
    };
    vi.restoreAllMocks();
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

    await run('import', '--repo', REPO, '--file', file('/k.pem', PEM));
    await run('import', '--repo', REPO, '--file', file('/seed', SEED_BASE64));
    await run('import', '--repo', REPO, '--file', file('/other.pem', OTHER_PEM));
    await run('import', '--repo', REPO, '--file', file('/other.pem', OTHER_PEM), '--replace');
    await run('show', '--repo', REPO);
    // Refusals of files that hold key material.
    await run('import', '--repo', REPO, '--file', file('/short', SEED_BASE64.slice(4)));
    await run('import', '--repo', REPO, '--file', file('/broken', PEM.replace('MC4C', '!!!!')));
    await run('import', '--repo', REPO, '--file', file('/odd', `${SEED_HEX}\n`));
    await run('import', '--repo', REPO, '--file', file('/tagged', PEM), '--tag', 'a\nb');

    vi.restoreAllMocks();
    expect(process.env).toEqual(envBefore);
    const everything = [...said, ...Object.values(process.env).map(String)].join('\n');
    const otherBody = OTHER_PEM.split('\n').filter((line) => line && !line.startsWith('-----'));
    for (const secret of [SEED_HEX, SEED_BASE64, PEM_BODY, SEED_BASE64.slice(4), ...otherBody]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('are read only as the two forms, never anything else', () => {
    const fromSeed = readReleaseKey(Buffer.from(SEED_BASE64));
    const fromPem = readReleaseKey(Buffer.from(PEM));
    expect('key' in fromSeed && 'key' in fromPem).toBe(true);
    if ('key' in fromSeed && 'key' in fromPem) {
      expect(fromSeed.key.export({ type: 'pkcs8', format: 'der' })).toEqual(fromPem.key.export({ type: 'pkcs8', format: 'der' }));
    }
    // Hex of the seed is 64 characters of base64's alphabet, but 48 bytes: refused.
    expect(readReleaseKey(Buffer.from(SEED_HEX))).toHaveProperty('refusal');
    expect(createPrivateKey(PEM).asymmetricKeyType).toBe('ed25519');
  });
});
