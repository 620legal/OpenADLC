import { identities } from '@fleetadlc/db';
import { credentialKind, getSecretStore, type SecretStore } from '@fleetadlc/github';
import type { Bot } from '@fleetadlc/shared';

/**
 * Where a seat's GitHub sign-in is filed, and whether other seats share it.
 *
 * A seat on an account of its own has its sign-in under its own name, as it
 * always did. Seats that share one account share one sign-in, filed under the
 * account's name (its identity's `secret_ns`) — so "is this seat connected?"
 * and "which secrets move when this seat is renamed?" both have to ask here
 * rather than assume the seat's name.
 */
export interface SignIn {
  ns: string;
  shared: boolean;
}

export async function signInOf(bot: Pick<Bot, 'id' | 'name'>): Promise<SignIn> {
  // Anything that cannot say — no identity recorded, or none that can be
  // read — is the seat's own name, which is where every sign-in was before
  // accounts could be shared.
  try {
    const identity = await identities.identityOfBot(bot.id);
    if (!identity) return { ns: bot.name, shared: false };
    const seats = await identities.botsOnSecretNs(identity.secretNs);
    return { ns: identity.secretNs, shared: seats.length > 1 };
  } catch {
    return { ns: bot.name, shared: false };
  }
}

/** What kind of GitHub credential a seat holds, wherever its sign-in is filed. */
export async function signInKind(
  bot: Pick<Bot, 'id' | 'name'>,
  store: SecretStore = getSecretStore(),
): Promise<'refresh' | 'static' | null> {
  return credentialKind((await signInOf(bot)).ns, store);
}
