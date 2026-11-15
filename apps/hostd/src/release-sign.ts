import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { getSecretStore, parseReleaseKeyRecord, releaseSigningKeyRef, type SecretStore } from '@openadlc/github';
import { releaseManifestAsset, releaseMessage, type ReleaseFields } from '@openadlc/shared';

/**
 * Signing a release (ADR 0068, ADR 0069): the one place in the install that
 * reads a repository's release signing key.
 *
 * The key never leaves this function. It is not written to `process.env`,
 * logged, returned or put in an error, so nothing a release run's account is
 * handed can carry it, and an exception from here is safe to store or post.
 * The tag comes only from the key's record, never from a parameter: clients
 * pin it with the public key, and no caller may choose it per release. The
 * values come only from the caller's typed fields, which hostd computes
 * itself (ADR 0068), and are checked before the key is touched.
 */

export interface SignedRelease {
  /** The exact bytes signed: tag, version, sha256 and url, each ended by LF. */
  message: Uint8Array;
  /** The 64-byte ed25519 signature, standard base64 with padding (88 characters). */
  sig: string;
  /** The published manifest asset: `{"version","url","sha256","sig"}` and one LF. */
  asset: string;
  /** The public key the signature checks against, the raw 32 bytes in base64. */
  publicKey: string;
}

/** What to run on the host when there is no usable key for a repository. */
function importAdvice(repo: string, replace: boolean): string {
  return `Run on the host: openadlc release-key import --repo ${repo} --file <path>${replace ? ' --replace' : ''}`;
}

/** The raw 32-byte public key of an ed25519 key, from its SPKI DER (12 bytes of header, then the key). */
export function rawPublicKey(key: KeyObject): Buffer {
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32);
}

export async function signRelease(
  repo: string,
  fields: ReleaseFields,
  store: SecretStore = getSecretStore(),
): Promise<SignedRelease> {
  const stored = await store.get(releaseSigningKeyRef(repo));
  if (stored === null) throw new Error(`no release signing key for ${repo}. ${importAdvice(repo, false)}`);
  const record = parseReleaseKeyRecord(stored);
  if (!record) throw new Error(`the release signing key filed for ${repo} cannot be read. ${importAdvice(repo, true)}`);
  if (record.repo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`the release signing key filed for ${repo} names another repository. ${importAdvice(repo, true)}`);
  }

  // Before the key is parsed: a value that breaks the layout never reaches it.
  const message = releaseMessage(record.tag, fields);

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: record.key, format: 'pem' });
  } catch {
    // crypto's own error is dropped, not wrapped: it could quote the PEM.
    throw new Error(`the release signing key filed for ${repo} is not a private key. ${importAdvice(repo, true)}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`the release signing key filed for ${repo} is not ed25519. ${importAdvice(repo, true)}`);
  }

  const signature = sign(null, message, privateKey);
  const publicKey = createPublicKey(privateKey);
  // Checked before it is published: a signature clients refuse is a release
  // nobody can install, found by them rather than here.
  if (!verify(null, message, publicKey, signature)) {
    throw new Error(`the signature made for ${repo} does not verify against its own public key; nothing was published`);
  }

  const sig = signature.toString('base64');
  return { message, sig, asset: releaseManifestAsset(fields, sig), publicKey: rawPublicKey(privateKey).toString('base64') };
}
