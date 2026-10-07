import { GitHubApiError, generateSigningKey, publicKeyOf, sameSigningKey, signingKeyRef, type SecretStore } from '@fleetadlc/github';

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
}

export type SigningKeyResult = { state: 'registered' | 'uploaded'; keyId: number } | { state: 'refused'; warning: string };

export async function ensureSigningKeyRegistered(input: {
  name: string;
  store: SecretStore;
  client: SigningKeyClient;
  generate?: (name: string) => { privateKey: string; publicKey: string };
  derive?: (privateKey: string) => string;
}): Promise<SigningKeyResult> {
  const generate = input.generate ?? generateSigningKey;
  const derive = input.derive ?? publicKeyOf;

  const stored = await input.store.get(signingKeyRef(input.name));
  let publicKey: string;
  if (stored) {
    publicKey = derive(stored);
  } else {
    const pair = generate(input.name);
    await input.store.set(signingKeyRef(input.name), pair.privateKey);
    publicKey = pair.publicKey;
  }

  try {
    const known = (await input.client.listSshSigningKeys()).find((key) => sameSigningKey(key.key, publicKey));
    if (known) return { state: 'registered', keyId: known.id };
    const keyId = await input.client.uploadSshSigningKey(`fleetadlc-${input.name}`, publicKey);
    return { state: 'uploaded', keyId };
  } catch (error) {
    return { state: 'refused', warning: signingKeyWarning(input.name, error) };
  }
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
