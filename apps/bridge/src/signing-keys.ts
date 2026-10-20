import { GitHubApiError, generateSigningKey, publicKeyOf, sameSigningKey, signingKeyRef, type SecretStore } from '@openadlc/github';

/**
 * Makes sure the key a bot signs its commits with is one its GitHub account
 * knows.
 *
 * The key used to be uploaded only in the moment it was generated. When that
 * upload was refused — every one was, because the app lacked the "SSH signing
 * keys" permission — the key stayed in the secret store, GitHub never learned
 * it, and reconnecting the bot changed nothing: a key already existed, so no
 * upload was tried again. The builder's first pull request came out signed and
 * Unverified, which a branch that requires signatures will not merge.
 *
 * So the stored key (or a new one, when there is none) is checked against the
 * account's signing keys and uploaded when it is missing. A refusal comes back
 * as a sentence a person can act on, naming what the app needs.
 */
export interface SigningKeyClient {
  listSshSigningKeys(): Promise<{ id: number; title: string; key: string }[]>;
  uploadSshSigningKey(title: string, publicKey: string): Promise<number>;
  deleteSshSigningKey(id: number): Promise<void>;
}

export type SigningKeyResult = { state: 'registered' | 'uploaded'; keyId: number } | { state: 'refused'; warning: string };

/** The title every key OpenADLC registers for this bot carries: its own namespace, so a stale one can be recognised. */
export function signingKeyTitle(name: string): string {
  return `openadlc-${name}`;
}

/**
 * Keys OpenADLC itself uploaded for this bot and then lost track of: the bot's
 * title on a key that is not the bot's current key. Each is removed, best
 * effort — a token that may not delete leaves them for the health check's
 * card, which now offers Revoke and Dismiss — so a retried registration heals
 * the account instead of growing its list.
 */
async function removeStale(client: SigningKeyClient, listed: readonly { id: number; title: string; key: string }[], name: string, publicKey: string): Promise<void> {
  const stale = listed.filter((key) => key.title === signingKeyTitle(name) && !sameSigningKey(key.key, publicKey));
  for (const key of stale) await client.deleteSshSigningKey(key.id).catch(() => undefined);
}

/**
 * The key a bot signs with: the stored one, or a new pair stored now. With
 * the public half when this call made the pair that the store kept, so it is
 * not derived again.
 *
 * Two of these can run at once — a connect (`ensureSigningKeyRegistered`) and
 * the scheduled signing-key check — and each used to upload its own fresh pair
 * under the same title, leaving whichever lost the store write as "a key
 * OpenADLC did not register". The store keeps one, so the store is read again
 * after the write, and that one is registered, whoever wrote it. Both paths
 * come through here so the rule cannot hold on one and drift on the other.
 */
export async function settledSigningKey(
  name: string,
  store: Pick<SecretStore, 'get' | 'set'>,
  generate: (name: string) => { privateKey: string; publicKey: string } = generateSigningKey,
): Promise<{ privateKey: string; publicKey: string | null }> {
  const stored = await store.get(signingKeyRef(name));
  if (stored) return { privateKey: stored, publicKey: null };
  const pair = generate(name);
  await store.set(signingKeyRef(name), pair.privateKey);
  const settled = await store.get(signingKeyRef(name));
  return settled && settled !== pair.privateKey ? { privateKey: settled, publicKey: null } : pair;
}

export async function ensureSigningKeyRegistered(input: {
  name: string;
  store: SecretStore;
  client: SigningKeyClient;
  generate?: (name: string) => { privateKey: string; publicKey: string };
  derive?: (privateKey: string) => string;
}): Promise<SigningKeyResult> {
  const generate = input.generate ?? generateSigningKey;
  const derive = input.derive ?? publicKeyOf;

  const settled = await settledSigningKey(input.name, input.store, generate);
  const publicKey = settled.publicKey ?? derive(settled.privateKey);

  try {
    const listed = await input.client.listSshSigningKeys();
    await removeStale(input.client, listed, input.name, publicKey);
    const known = listed.find((key) => sameSigningKey(key.key, publicKey));
    if (known) return { state: 'registered', keyId: known.id };
    const keyId = await input.client.uploadSshSigningKey(signingKeyTitle(input.name), publicKey);
    return { state: 'uploaded', keyId };
  } catch (error) {
    // A concurrent registration can land the same key between the list and the
    // upload; GitHub then refuses the second upload as already in use, which
    // means registered, not refused.
    if (alreadyInUse(error)) {
      const again = await input.client.listSshSigningKeys().catch(() => []);
      const known = again.find((key) => sameSigningKey(key.key, publicKey));
      if (known) return { state: 'registered', keyId: known.id };
    }
    return { state: 'refused', warning: signingKeyWarning(input.name, error) };
  }
}

/** GitHub's answer to uploading a key the account already has. */
export function alreadyInUse(error: unknown): boolean {
  if (!(error instanceof GitHubApiError) || error.status !== 422) return false;
  return /already in use|already exists/i.test(error.message);
}

/**
 * Why a bot's sign-in cannot delete signing keys on its GitHub account, or
 * null when it can — asked before the card offers Revoke, so a sign-in that
 * may not is a sentence on the card instead of a button that fails.
 *
 * A device-flow sign-in acts under the app's account permissions, so deleting
 * needs the app's "SSH signing keys" as Read and write — the same permission
 * registering needs. A static token is a classic personal access token, whose
 * `admin:ssh_signing_key` scope is what deleting needs; one whose recorded
 * scopes do not name it (a fine-grained token records none) is read as unable.
 */
export function revokeGate(kind: 'refresh' | 'static' | null, scopes: readonly string[], appLacksSigning: boolean): string | null {
  if (kind === 'refresh') {
    return appLacksSigning
      ? 'the OpenADLC app does not hold “SSH signing keys” as Read and write (under Account permissions in the app’s settings), which deleting a key needs'
      : null;
  }
  if (kind === 'static') {
    return scopes.includes('admin:ssh_signing_key')
      ? null
      : 'the bot’s sign-in is a personal access token without the admin:ssh_signing_key scope, which deleting a signing key needs';
  }
  return 'the bot holds no working sign-in';
}

/** Why GitHub would not take the key, as the person who can fix it needs to read it. */
export function signingKeyWarning(name: string, error: unknown): string {
  if (error instanceof GitHubApiError && error.status === 403) {
    return (
      `GitHub would not register ${name}'s signing key: the OpenADLC app needs the "SSH signing keys" permission ` +
      `(Read and write, under Account permissions in the app's settings). Add it, then connect ${name} again — ` +
      `until then its commits read Unverified and a branch that requires signatures will not take them.`
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return `GitHub would not register ${name}'s signing key: ${message.slice(0, 200)}`;
}
