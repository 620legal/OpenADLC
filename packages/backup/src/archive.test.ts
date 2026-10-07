import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BackupError,
  decryptBackup,
  encryptBackup,
  formatOf,
  generatePassphrase,
  passphraseRefusal,
  passphraseWarning,
  PASSPHRASE_ADVISED_LENGTH,
  readManifest,
  readPlain,
  writePlain,
  type BackupContents,
} from './index.js';

/**
 * An install is a crew of seats on one or more GitHub accounts, a GitHub App
 * private key, a device-flow refresh token per account, a webhook secret and a
 * settings table. These tests are about the two ways a restore fails in practice.
 *
 * It fails quietly: the archive round-trips *almost* everything, and the PEM
 * comes back with its newlines eaten or a not-yet-authorized bot comes back with
 * `''` where it had `null`. Nobody finds out until the crew cannot sign a commit.
 *
 * Or it fails as protection: a wrong passphrase hands back half a payload, or the
 * cleartext manifest can be edited to describe a file it is not attached to.
 *
 * Nothing here reads or writes `~/.fleetadlc`. Every secret below is invented, and
 * the one case that needs a real file uses a temporary directory it removes
 * afterwards. The suite is deliberately slow — each encrypt and each decrypt pays
 * the full scrypt cost on purpose, because that cost is the protection.
 */

const PASSPHRASE = 'correct horse battery staple — with an ø in it';

/**
 * The real thing: several lines, and a trailing newline. Made here rather than
 * written out, so no key-shaped text sits in the repository for a secret
 * scanner to raise.
 */
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** A human's name is the field most likely to be outside ASCII. */
const HUMANS = 'Åsa Ørsted — 澤利 🛰️';

const install: BackupContents = {
  manifest: {
    version: 1,
    createdAt: '2026-09-21T09:14:00.000Z',
    counts: { secrets: 4, settings: 4, bots: 4 },
  },
  secrets: {
    'github-app-private-key': PEM,
    // A backup of everything carries each bot's GitHub sign-in, and this
    // package round-trips whatever it is handed.
    'github-refresh-nova': `ghr_${'a'.repeat(40)}`,
    'github-refresh-pilot': `ghr_${'b'.repeat(40)}`,
    'webhook-secret': 'whsec_ø-not-ascii-either',
  },
  settings: {
    organization: 'janedoe',
    githubClientId: 'Iv23liABCDEFGHIJKLMN',
    humans: HUMANS,
    publicUrl: 'https://fleetadlc.example.test',
  },
  bots: [
    { name: 'nova', githubLogin: 'fleetadlc-nova', engine: 'claude', model: 'claude-opus-4-20250514' },
    { name: 'pilot', githubLogin: 'fleetadlc-pilot', engine: 'codex', model: null },
    // Not authorized yet: no login at all. The state a fresh install spends most
    // of its setup in, and the one a lossy round trip is likeliest to corrupt.
    { name: 'scout', githubLogin: null, engine: 'grok', model: 'grok-4' },
    { name: 'demo', githubLogin: null, engine: 'none', model: null },
  ],
};

/** Every value in the archive that must never appear in cleartext. */
const SENSITIVE = [...Object.values(install.secrets), ...Object.values(install.settings)];

let archive: Buffer;
let restored: BackupContents;

beforeAll(async () => {
  archive = await encryptBackup(install, PASSPHRASE);
  restored = await decryptBackup(archive, PASSPHRASE);
});

/**
 * Runs something that must be refused, and returns the BackupError. Throws if
 * nothing was thrown, and rethrows anything that is not a BackupError, so a
 * TypeError from a crypto internal cannot pass as a clean refusal.
 */
async function refusal(attempt: () => unknown): Promise<BackupError> {
  try {
    await attempt();
  } catch (error) {
    if (error instanceof BackupError) return error;
    throw error;
  }
  throw new Error('the archive was accepted, and should not have been');
}

/** Where the cleartext header ends and salt || iv || tag || ciphertext begins. */
function bodyStart(bytes: Buffer): number {
  const magicLine = bytes.indexOf(0x0a);
  return bytes.indexOf(0x0a, magicLine + 1) + 1;
}

function flip(bytes: Buffer, offset: number): Buffer {
  const copy = Buffer.from(bytes);
  copy[offset] = copy[offset]! ^ 0x01;
  return copy;
}

describe('an archive round-trips an install exactly', () => {
  it('gives back every secret ref and value it was handed', () => {
    expect(restored.secrets).toEqual(install.secrets);
  });

  it('gives back a private key with its line breaks intact', () => {
    // A PEM whose newlines were collapsed or whose trailing newline was trimmed
    // is not a usable key, and JSON round-tripping is exactly where that happens.
    expect(restored.secrets['github-app-private-key']).toBe(PEM);
    expect(restored.secrets['github-app-private-key']?.split('\n')).toHaveLength(PEM.split('\n').length);
    expect(restored.secrets['github-app-private-key']?.endsWith('KEY-----\n')).toBe(true);
  });

  it('gives back non-ASCII settings unchanged, down to the emoji', () => {
    expect(restored.settings['humans']).toBe(HUMANS);
    // Written as code points, because a utf8/latin1 slip anywhere in the pipeline
    // mangles both sides of a `toBe` equally and passes. An astral character (the
    // satellite, outside the BMP) is the one that breaks first.
    expect(restored.settings['humans']).toMatch(/\u{1F6F0}/u);
    expect(restored.settings['humans']).toMatch(/Ø/);
  });

  it('gives back the crew in order, with nulls still null', () => {
    expect(restored.bots).toEqual(install.bots);
    expect(restored.bots.map((bot) => bot.name)).toEqual(['nova', 'pilot', 'scout', 'demo']);
    // Not `''`, not `undefined`: a restore reads this to decide whether the bot
    // still needs to go through device flow.
    expect(restored.bots[2]?.githubLogin).toBeNull();
    expect(restored.bots[1]?.model).toBeNull();
  });

  it('gives back the manifest it wrote', () => {
    expect(restored.manifest).toEqual(install.manifest);
  });
});

describe('the cleartext manifest describes the file, not the caller', () => {
  it('counts what is actually in the archive', async () => {
    // The manifest is the one part nobody has to prove anything to read, so it
    // must not be able to claim an install that is not in the file. The counts
    // are taken from the payload; these wrong ones are ignored.
    const lying = await encryptBackup({ ...install, manifest: { ...install.manifest, counts: { secrets: 0, settings: 0, bots: 99 } } }, PASSPHRASE);

    expect(readManifest(lying).counts).toEqual({ secrets: 4, settings: 4, bots: 4 });
  });
});

describe('a file can say what it is without the passphrase', () => {
  it('reads the manifest with no passphrase at all', () => {
    const manifest = readManifest(archive);

    expect(manifest.version).toBe(1);
    expect(manifest.createdAt).toBe('2026-09-21T09:14:00.000Z');
    expect(manifest.counts).toEqual({ secrets: 4, settings: 4, bots: 4 });
  });

  it('names nothing an operator would not want written on the outside', () => {
    // The manifest exists so a person with a drive full of files can find the
    // right one. It must not turn the filename into a disclosure: no secret ref,
    // no secret value, no organization, no bot login.
    const serialized = JSON.stringify(readManifest(archive));

    for (const ref of Object.keys(install.secrets)) expect(serialized).not.toContain(ref);
    for (const value of SENSITIVE) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('janedoe');
    expect(serialized).not.toContain('fleetadlc-nova');
    expect(serialized).not.toContain('claude');
  });

  it('keeps the values out of the file altogether, not just out of the manifest', () => {
    // Compared as bytes rather than strings, so a utf8 value cannot slip past a
    // latin1 search. If any of these is present, something was written outside
    // the ciphertext.
    for (const value of SENSITIVE) {
      expect(archive.includes(Buffer.from(value, 'utf8'))).toBe(false);
    }
    expect(archive.includes(Buffer.from('fleetadlc-nova', 'utf8'))).toBe(false);
  });
});

describe('when an archive says it was made', () => {
  const header = (createdAt: string) =>
    Buffer.concat([Buffer.from(`FLEETBAK1\n${JSON.stringify({ ...install.manifest, createdAt })}\n`, 'utf8'), randomBytes(64)]);

  it('is a time in UTC and nothing else, since it is printed before any passphrase proves the file', async () => {
    // Anything that starts with FLEETBAK1 could send a terminal its escape
    // sequences, to the person about to type a passphrase. `Date.parse` takes
    // the second of these.
    for (const createdAt of ['\u001b]52;c;cHduZWQ=\u0007', '2026-09-21T09:14:00Z (\u001b[2J)', '2026-09-21 09:14', '2026-09-21T09:14:00+02:00']) {
      expect((await refusal(() => readManifest(header(createdAt)))).message).toContain('is not a time in UTC');
    }
  });

  it('is read as `toISOString` writes it', () => {
    expect(readManifest(header('2026-09-21T09:14:00Z')).createdAt).toBe('2026-09-21T09:14:00.000Z');
  });
});

describe('a wrong passphrase is refused rather than approximated', () => {
  it('says what went wrong in words an operator can act on', async () => {
    const error = await refusal(() => decryptBackup(archive, 'not the passphrase'));

    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toContain('that passphrase does not open this archive');
    // Not a leaked crypto internal: `Unsupported state or unable to authenticate
    // data` is what Node says, and it reads like a bug in OpenADLC.
    expect(error.message).not.toContain('Unsupported state');
  });

  it('returns nothing at all, not a partial payload', async () => {
    // GCM's `update` yields plaintext before the tag is checked. If that ever
    // escaped, a wrong passphrase would hand back a corrupt install that looks
    // restorable.
    let produced: unknown = 'nothing was returned';

    await expect(
      (async () => {
        produced = await decryptBackup(archive, 'not the passphrase either');
      })(),
    ).rejects.toThrow(BackupError);

    expect(produced).toBe('nothing was returned');
  });
});

describe('an archive too large to write says what to leave out', () => {
  // V8 caps a string at about 536 million characters; an install with some
  // 380 MiB of attachments in its history reaches it. Not allocated here.
  function tooLong() {
    return vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
  }

  it('refuses to seal it with a BackupError naming history, not a bare RangeError', async () => {
    const spy = tooLong();
    try {
      const error = await refusal(() => encryptBackup(install, PASSPHRASE));
      expect(error).toBeInstanceOf(BackupError);
      expect(error.message).toContain('too large');
      expect(error.message).toContain('without history');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses to write it unencrypted the same way', () => {
    const spy = tooLong();
    try {
      expect(() => writePlain(install)).toThrow(BackupError);
      expect(() => writePlain(install)).toThrow(/without history/);
    } finally {
      spy.mockRestore();
    }
  });

  it('lets any other failure through unchanged', () => {
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new TypeError('Do not know how to serialize a BigInt');
    });
    try {
      expect(() => writePlain(install)).toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a tampered archive does not open', () => {
  it('catches a single flipped bit anywhere in the ciphertext', async () => {
    const start = bodyStart(archive) + 16 + 12 + 16;
    const offsets = [start, Math.floor((start + archive.length) / 2), archive.length - 1];

    for (const offset of offsets) {
      expect(await refusal(() => decryptBackup(flip(archive, offset), PASSPHRASE))).toBeInstanceOf(BackupError);
    }
  });

  it('catches a flipped bit in the salt, the IV or the auth tag', async () => {
    // The salt and IV are cleartext, so they are the easiest bytes to edit, and
    // editing them is how you would try to make one archive decrypt as another.
    const start = bodyStart(archive);
    for (const offset of [start, start + 16, start + 28]) {
      expect(await refusal(() => decryptBackup(flip(archive, offset), PASSPHRASE))).toBeInstanceOf(BackupError);
    }
  });

  it('catches an edited manifest, because the cleartext header is the AAD', async () => {
    // Same length, so every offset after it still lines up — the change is
    // undetectable by inspection, which is the point.
    const edited = Buffer.from(archive.toString('latin1').replace('"bots":4', '"bots":9'), 'latin1');
    expect(edited.length).toBe(archive.length);

    // The unauthenticated read believes the lie, and has no way not to: there is
    // no key involved. This is why the manifest is a label, not evidence.
    expect(readManifest(edited).counts.bots).toBe(9);

    // The authenticated read does not. Asserted on the message, not just the
    // type: this edit also contradicts the payload, so a counts cross-check would
    // refuse it too, and then the test would pass with the AAD removed. The
    // authentication failure is the thing being pinned here.
    expect((await refusal(() => decryptBackup(edited, PASSPHRASE))).message).toContain('has been altered');
  });

  it('catches a createdAt that was backdated after the fact', async () => {
    const edited = Buffer.from(archive.toString('latin1').replace('2026-09-21', '2019-01-01'), 'latin1');

    expect(await refusal(() => decryptBackup(edited, PASSPHRASE))).toBeInstanceOf(BackupError);
  });

  it('catches an archive that lost its last byte in transit', async () => {
    expect(await refusal(() => decryptBackup(archive.subarray(0, archive.length - 1), PASSPHRASE))).toBeInstanceOf(
      BackupError,
    );
  });

  it('says a header with no contents behind it is truncated, before asking for a key', async () => {
    const headerOnly = archive.subarray(0, bodyStart(archive) + 20);

    expect((await refusal(() => decryptBackup(headerOnly, PASSPHRASE))).message).toContain('truncated');
  });
});

describe('a file that is not an OpenADLC backup fails as a file, not as a cipher', () => {
  it('refuses random bytes by naming the header it wanted', async () => {
    const error = await refusal(() => decryptBackup(randomBytes(512), PASSPHRASE));

    expect(error.message).toContain('FLEETBAK1');
    // The distinction that matters: "you pointed me at the wrong file" is a
    // different problem from "you typed the wrong passphrase", and an operator
    // who is told the second will go on retyping the first.
    expect(error.message).not.toContain('passphrase');
  });

  it('refuses a JSON file, which is what gets pointed at by mistake', async () => {
    const json = Buffer.from(JSON.stringify({ organization: 'janedoe', bots: [] }), 'utf8');

    expect((await refusal(() => decryptBackup(json, PASSPHRASE))).message).toContain('not an OpenADLC backup');
  });

  it('refuses an empty file', async () => {
    expect((await refusal(() => decryptBackup(Buffer.alloc(0), PASSPHRASE))).message).toContain('not an OpenADLC backup');
  });

  it('refuses to identify one too, rather than crashing on the read', async () => {
    // `readManifest` is what a CLI calls on every candidate file to decide what
    // it is looking at, so it is the function most likely to meet a stray file.
    expect(await refusal(() => readManifest(randomBytes(64)))).toBeInstanceOf(BackupError);
  });

  it('tells the operator when an archive came from a newer OpenADLC', async () => {
    // Recognisably ours but not readable by us: worth saying so, because the
    // remedy is a newer OpenADLC and not a different passphrase.
    const future = Buffer.concat([Buffer.from('FLEETBAK2\n{"version":2}\n', 'utf8'), randomBytes(64)]);
    const error = await refusal(() => readManifest(future));

    expect(error.message).toContain('FLEETBAK2');
    expect(error.message).toContain('FLEETBAK1');
    expect(error.message).toContain('Upgrade OpenADLC, then restore again');
  });

  it('reads a plain file written before the rename from Fleet', () => {
    // It said `fleet-backup-plain`, and was refused as not a backup at all.
    const document = JSON.parse(writePlain(install).toString('utf8')) as { format: string };
    document.format = 'fleet-backup-plain';
    const old = Buffer.from(JSON.stringify(document), 'utf8');

    expect(formatOf(old)).toBe('plain');
    expect(readPlain(old).secrets).toEqual(install.secrets);
  });

  it('says to upgrade when the contents declare a newer version', async () => {
    const document = JSON.parse(writePlain(install).toString('utf8')) as { manifest: { version: number } };
    document.manifest.version = 4;
    const error = await refusal(() => readPlain(Buffer.from(JSON.stringify(document), 'utf8')));

    expect(error.message).toContain('this backup declares version 4, and this version of OpenADLC reads versions 1, 2 and 3');
    expect(error.message).toContain('Upgrade OpenADLC, then restore again');
  });
});

describe('two backups of the same install are two different files', () => {
  let first: Buffer;
  let second: Buffer;

  beforeAll(async () => {
    first = await encryptBackup(install, PASSPHRASE);
    second = await encryptBackup(install, PASSPHRASE);
  });

  it('draws a fresh salt and IV for each', () => {
    // Identical bytes would mean the salt and IV came from the contents or the
    // passphrase instead of the RNG — which reuses a GCM nonce under one key, the
    // single failure the mode does not survive, and also lets anyone holding two
    // dumps see whether the install changed between them.
    const at = bodyStart(first);
    expect(first.subarray(at, at + 16).equals(second.subarray(at, at + 16))).toBe(false);
    expect(first.subarray(at + 16, at + 28).equals(second.subarray(at + 16, at + 28))).toBe(false);
    expect(first.equals(second)).toBe(false);
  });

  it('opens both with the one passphrase, so only the nonces differ', async () => {
    expect(await decryptBackup(first, PASSPHRASE)).toEqual(await decryptBackup(second, PASSPHRASE));
  });
});

describe('an empty passphrase is not a passphrase', () => {
  it('refuses to write an archive that needs no secret to open', async () => {
    expect((await refusal(() => encryptBackup(install, ''))).message).toContain('empty');
  });

  it('refuses to read with one, instead of pretending to try', async () => {
    expect(await refusal(() => decryptBackup(archive, ''))).toBeInstanceOf(BackupError);
  });
});

describe('a short passphrase is warned about, never refused', () => {
  it('warns under 12 characters, counted by code point after normalising', () => {
    expect(PASSPHRASE_ADVISED_LENGTH).toBe(12);
    expect(passphraseWarning('1234')).toMatch(/^Shorter than 12 characters: anyone who gets this file can guess/);
    expect(passphraseWarning('a'.repeat(11))).not.toBeNull();
    expect(passphraseWarning('a'.repeat(12))).toBeNull();
    // Eleven letters and a combining accent are eleven characters once normalised.
    expect(passphraseWarning('cafe\u0301-au-lai')).not.toBeNull();
    // Twelve emoji are twelve, though they are twenty-four UTF-16 units.
    expect(passphraseWarning('🔑'.repeat(11))).not.toBeNull();
    expect(passphraseWarning('🔑'.repeat(12))).toBeNull();
  });

  it('still takes a short matching pair', () => {
    expect(passphraseRefusal('a', 'a')).toBeNull();
    expect(passphraseRefusal('1234', '1234')).toBeNull();
  });

  it('still seals and opens an archive with a one-character passphrase', async () => {
    const sealed = await encryptBackup(install, 'a');
    expect(await decryptBackup(sealed, 'a')).toEqual(install);
  });

  it('offers a generated one: long, random, and from an alphabet without look-alikes', () => {
    const one = generatePassphrase();
    expect(one).toMatch(/^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){4}$/);
    expect(one.length).toBeGreaterThanOrEqual(PASSPHRASE_ADVISED_LENGTH);
    expect(passphraseWarning(one)).toBeNull();
    expect(generatePassphrase()).not.toBe(one);
  });
});

describe('an archive survives the trip through a file', () => {
  let dir: string;
  let path: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleetadlc-backup-'));
    path = join(dir, 'fleetadlc-backup-2026-09-21.fleetbak');
    writeFileSync(path, archive);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('decrypts after being written and read back as bytes', async () => {
    // The whole point of the package is a file that outlives the machine, so at
    // least once the bytes should make the trip rather than staying in a Buffer.
    expect((await decryptBackup(readFileSync(path), PASSPHRASE)).secrets).toEqual(install.secrets);
  });

  it('identifies itself in its first two lines, which is all `head` needs', () => {
    const [magic, manifest] = readFileSync(path, 'latin1').split('\n');

    expect(magic).toBe('FLEETBAK1');
    expect(JSON.parse(manifest ?? '')).toEqual(install.manifest);
  });
});

describe('the unencrypted form', () => {
  /**
   * Encryption stays the default and this is the path somebody asks for. It is
   * still the same contents, so it round-trips the same way — and it has to
   * announce what it is, because the whole risk of the thing is that it looks
   * like an ordinary JSON file.
   */
  it('round-trips everything the sealed form does', () => {
    const plain = writePlain(install);
    const back = readPlain(plain);

    expect(back.secrets).toEqual(install.secrets);
    expect(back.settings).toEqual(install.settings);
    expect(back.bots).toEqual(install.bots);
    expect(back.manifest.counts).toEqual({
      secrets: Object.keys(install.secrets).length,
      settings: Object.keys(install.settings).length,
      bots: install.bots.length,
    });
  });

  it('warns in the first thing a reader sees', () => {
    const text = writePlain(install).toString('utf8');
    const firstKey = Object.keys(JSON.parse(text))[0];

    expect(firstKey).toBe('WARNING');
    expect(text.slice(0, 200)).toMatch(/UNENCRYPTED/);
  });

  it('says what the file holds and what a leak costs, which is not a device flow', () => {
    // The bots' GitHub sign-ins are in the file when they were chosen, and a
    // new device flow does not undo their leak: each authorization has to be
    // revoked. Non-expiring bot tokens and API keys have to be revoked and
    // rotated too.
    const warning = (JSON.parse(writePlain(install).toString('utf8')) as { WARNING: string }).WARNING;

    expect(warning).toContain('the bots’ GitHub sign-ins');
    expect(warning).toContain('revoking each bot’s GitHub authorization');
    expect(warning).toContain('any non-expiring bot tokens and API keys');
    expect(warning).toContain('revoking any non-expiring bot token, rotating every API key');
    expect(warning).not.toMatch(/device flow/);
  });

  it('names everything it can carry, and how to recover each after a leak', () => {
    // The registry token, the subscriptions' tokens and sign-ins and the
    // history were in the file and not in the list, so following the list
    // after a leak left them valid.
    const warning = (JSON.parse(writePlain(install).toString('utf8')) as { WARNING: string }).WARNING;

    expect(warning).toContain('registry token');
    expect(warning).toContain('subscription');
    expect(warning).toContain('OpenAI and xAI subscription sign-ins');
    expect(warning).toContain('history');
    expect(warning).toContain('rotating every API key and the registry token');
    expect(warning).toContain('signing each model subscription out and in again');
  });

  it('does hold the values, which is the entire point of the warning', () => {
    // Asserted rather than assumed: this is the difference between the two
    // formats, and a test suite that never states it is not describing them.
    const text = writePlain(install).toString('utf8');

    for (const value of Object.values(install.secrets)) {
      expect(text).toContain(JSON.stringify(value).slice(1, -1));
    }
  });

  it('is told apart from a sealed archive without a passphrase', async () => {
    expect(formatOf(writePlain(install))).toBe('plain');
    expect(formatOf(await encryptBackup(install, 'a passphrase'))).toBe('sealed');
  });

  it('is not confused by JSON that is not ours', () => {
    expect(formatOf(Buffer.from('{"hello":"world"}', 'utf8'))).toBe('unknown');
    expect(formatOf(Buffer.from('not json at all', 'utf8'))).toBe('unknown');
    expect(() => readPlain(Buffer.from('{"hello":"world"}', 'utf8'))).toThrow(BackupError);
  });

  it('refuses a sealed archive rather than returning nonsense', async () => {
    // A restore picks its path from `formatOf`, but the readers have to hold the
    // line themselves — a mixed-up call must fail, not half-succeed.
    const sealed = await encryptBackup(install, 'a passphrase');

    expect(() => readPlain(sealed)).toThrow(BackupError);
  });
});

describe('a bot’s seat', () => {
  it('comes back from an archive that has it, and stays absent in one written before seats', async () => {
    // A restore finds the row by seat. An archive that dropped it would be
    // matched by name, and names are handles that differ between installs.
    const seated: BackupContents = {
      ...install,
      bots: [
        { name: 'fleetadlc-atlas-janedoe', slot: 'builder', githubLogin: 'fleetadlc-atlas-janedoe', engine: 'claude', model: null },
        { name: 'nova', githubLogin: null, engine: 'claude', model: null },
      ],
      manifest: { ...install.manifest, counts: { ...install.manifest.counts, bots: 2 } },
    };

    const back = await decryptBackup(await encryptBackup(seated, PASSPHRASE), PASSPHRASE);

    expect(back.bots).toEqual(seated.bots);
    expect(back.bots[1]).not.toHaveProperty('slot');
  });
});
