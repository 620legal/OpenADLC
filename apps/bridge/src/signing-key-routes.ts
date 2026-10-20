import { GitHubApiError } from '@openadlc/github';
import { sameLogin, type Bot } from '@openadlc/shared';
import { revokeGate } from './signing-keys.js';
import { HttpFailure, type Router } from './router.js';

/**
 * What the signing-key card's buttons do about a key OpenADLC did not
 * register: say it is somebody's on purpose (and take that back), or delete it
 * from the bot's GitHub account with the bot's own sign-in. All three are an
 * admin's (`roles.ts`), and each is audited.
 */
export interface SigningKeyRouteDeps {
  crew(): Promise<Bot[]>;
  /** A client signed in as the bot, or null when it holds no working sign-in; see `Actors.asBot`. */
  asBot(name: string): Promise<{ deleteSshSigningKey(id: number): Promise<void> } | null>;
  signInKind(bot: Bot): Promise<'refresh' | 'static' | null>;
  /** The scopes the bot's authorization recorded, for the static-token half of `revokeGate`. */
  scopesOf(bot: Bot): Promise<string[]>;
  markExternal(login: string, keyId: number, by: string, title: string | null): Promise<void>;
  unmarkExternal(login: string, keyId: number): Promise<boolean>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<void>;
  /** Re-runs the signing-key check, so the card redraws from what GitHub lists now. */
  recheck(): void;
}

/** The key id from the path, which GitHub makes a number. */
function keyIdOf(params: Record<string, string>): number {
  const keyId = Number(params.keyId ?? '');
  if (!Number.isInteger(keyId) || keyId <= 0) throw new HttpFailure(400, 'the key id is GitHub’s numeric id for the key');
  return keyId;
}

export function registerSigningKeyRoutes(router: Router, deps: SigningKeyRouteDeps): void {
  /** "This key is used elsewhere": the check stops counting it, and the card says who said so. */
  router.post('/v1/signing-keys/:login/keys/:keyId/dismiss', async ({ params, body, identity }) => {
    const login = params.login ?? '';
    const keyId = keyIdOf(params);
    const input = await body<{ title?: unknown }>().catch(() => ({}) as { title?: unknown });
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : null;
    await deps.markExternal(login, keyId, identity, title);
    await deps.audit({ actor: identity, action: 'signing_key.dismissed', target: login, payload: { keyId, ...(title ? { title } : {}) } });
    deps.recheck();
    return { dismissed: keyId };
  });

  /** The undo: the key counts as a stranger's again. */
  router.add('DELETE', '/v1/signing-keys/:login/keys/:keyId/dismiss', async ({ params, identity }) => {
    const login = params.login ?? '';
    const keyId = keyIdOf(params);
    if (!(await deps.unmarkExternal(login, keyId))) {
      throw new HttpFailure(404, `no key ${keyId} on ${login} was dismissed`);
    }
    await deps.audit({ actor: identity, action: 'signing_key.undismissed', target: login, payload: { keyId } });
    deps.recheck();
    return { undismissed: keyId };
  });

  /**
   * Deletes the key from the bot's GitHub account, as the bot. The card offers
   * this only where `revokeGate` said the sign-in may; a static token is
   * checked here again, and for a device-flow sign-in GitHub's own refusal is
   * the answer, said in the app permission's words.
   */
  router.post('/v1/signing-keys/:login/keys/:keyId/revoke', async ({ params, identity }) => {
    const login = params.login ?? '';
    const keyId = keyIdOf(params);
    const bot = (await deps.crew()).find((seat) => seat.githubLogin && sameLogin(seat.githubLogin, login));
    if (!bot) throw new HttpFailure(404, `no seat is on ${login}`);
    const kind = await deps.signInKind(bot).catch(() => null);
    const blocked = revokeGate(kind, await deps.scopesOf(bot).catch(() => []), false);
    if (blocked) throw new HttpFailure(409, `the key cannot be revoked from here: ${blocked}`);
    const client = await deps.asBot(bot.name);
    if (!client) throw new HttpFailure(409, `the key cannot be revoked from here: ${bot.name} holds no working sign-in`);
    let alreadyGone = false;
    try {
      await client.deleteSshSigningKey(keyId);
    } catch (error) {
      // Gone already — revoked on GitHub, or by a press that raced this one —
      // is what revoking was for, not a failure.
      if (error instanceof GitHubApiError && error.status === 404) {
        alreadyGone = true;
      } else if (error instanceof GitHubApiError && (error.status === 403 || error.status === 401)) {
        throw new HttpFailure(
          403,
          `GitHub refused to delete the key as ${login}: the sign-in needs the OpenADLC app’s “SSH signing keys” as Read and write ` +
            `(under Account permissions in the app’s settings), and the account must approve the app again after it is added.`,
        );
      } else {
        throw error;
      }
    }
    await deps.audit({ actor: identity, action: 'signing_key.revoked', target: login, payload: { keyId, ...(alreadyGone ? { alreadyGone } : {}) } });
    deps.recheck();
    return { revoked: keyId, ...(alreadyGone ? { alreadyGone } : {}) };
  });
}
