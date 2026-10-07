import { generateKeyPairSync, randomBytes } from 'node:crypto';

export interface SigningKeyPair {
  privateKey: string;
  publicKey: string;
}

const MAGIC = Buffer.from('openssh-key-v1\0', 'binary');
const BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const END = '-----END OPENSSH PRIVATE KEY-----';

/** An SSH wire-format string: a uint32 length, then the bytes. */
function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

/**
 * Generates the bot's commit-signing key. The private half goes to the secret
 * store and is loaded into a per-task ssh-agent; it never lands on a container's
 * disk. The public half is uploaded to the bot's own GitHub account.
 *
 * The key is made and encoded in memory. It used to be written by `ssh-keygen`
 * into a directory under the temp directory and read back, so a crash, an OOM
 * kill or a container stop between the write and the clean-up left a working
 * signing key in /tmp. The result is what `ssh-keygen -t ed25519 -N ''` makes:
 * an unencrypted openssh-key-v1 ed25519 key with the comment `fleetadlc-<bot>`.
 */
export function generateSigningKey(bot: string): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const comment = `fleetadlc-${bot}`;
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);

  const check = randomBytes(4);
  const section = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  // The private section is padded with 1, 2, 3, … to the cipher's block size,
  // which is 8 for "none".
  const padding = Buffer.from(Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, i) => i + 1));

  const body = Buffer.concat([
    MAGIC,
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(blob),
    sshString(Buffer.concat([section, padding])),
  ]).toString('base64');
  const lines = body.match(/.{1,70}/g) ?? [];

  return {
    privateKey: `${BEGIN}\n${lines.join('\n')}\n${END}\n`,
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}`,
  };
}

/**
 * The public half of a stored signing key, so the key a bot already has can be
 * checked against what its GitHub account knows — rather than only uploading
 * a key the moment it is made, which left every bot whose first upload was
 * refused with a key GitHub never learned.
 *
 * Read from the key's own public blob in memory, for the same reason the key is
 * made in memory: running `ssh-keygen -y` meant writing the private key to a file
 * first. The comment is left off; `sameSigningKey` ignores it.
 */
export function publicKeyOf(privateKey: string): string {
  const text = privateKey.trim();
  if (!text.startsWith(BEGIN) || !text.endsWith(END)) {
    throw new Error('the signing key is not an OpenSSH private key (no "BEGIN OPENSSH PRIVATE KEY" armour)');
  }
  const data = Buffer.from(text.slice(BEGIN.length, -END.length).replace(/\s+/g, ''), 'base64');
  if (data.length < MAGIC.length || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('the signing key is not an openssh-key-v1 key');
  }
  let at = MAGIC.length;
  const next = (): Buffer => {
    if (at + 4 > data.length) throw new Error('the signing key is cut short');
    const length = data.readUInt32BE(at);
    if (at + 4 + length > data.length) throw new Error('the signing key is cut short');
    const out = data.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    return out;
  };
  const cipher = next().toString('utf8');
  if (cipher !== 'none') {
    throw new Error(`the signing key is encrypted (${cipher}); a bot's signing key must have no passphrase`);
  }
  next(); // kdf name
  next(); // kdf options
  if (at + 4 > data.length) throw new Error('the signing key is cut short');
  at += 4; // number of keys
  const blob = next();
  const typeLength = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const type = 4 + typeLength <= blob.length ? blob.subarray(4, 4 + typeLength).toString('utf8') : '';
  if (!/^[a-z0-9@.-]+$/.test(type)) throw new Error('the signing key has no readable public key');
  return `${type} ${blob.toString('base64')}`;
}

/** Whether two public keys are the same key: type and body, whatever the comment says. */
export function sameSigningKey(a: string, b: string): boolean {
  const body = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(' ');
  return body(a) !== '' && body(a) === body(b);
}
