import { getSecretStore, registryTokenRef, type SecretStore } from '@fleetadlc/github';
import { envOr } from '@fleetadlc/shared';

export interface RegistryGrant {
  /**
   * The registry the token is good for, so the install wrapper can scope its
   * npmrc to that one host. It does not stop a task sending the token
   * anywhere else: the session reads the raw token, and its egress decides
   * where it can go. Hence a read-only token (docs/self-hosting.md).
   */
  host: string;
  token: string;
  /**
   * Seconds the task may cache it. Short, because rotation is the point. A
   * caching hint, not an expiry: the token works until a person rotates it.
   */
  maxAgeSeconds: number;
}

export interface RegistryRefusal {
  error: string;
  remedy: string;
  /**
   * Whether the install names a registry. hostd's route answers from this,
   * not from the message: 501 (nothing to serve, install publicly) only when
   * it does not, 503 (fail the install) when it does but has no token.
   */
  configured: boolean;
}

/** How long a task may reuse a grant before asking again. */
export const REGISTRY_TOKEN_MAX_AGE_SECONDS = 300;

/**
 * The credential a task uses to install from a private package registry.
 *
 * Read per request, never baked into the session environment. A task that runs
 * for an hour and installs at minute fifty would otherwise present whatever was
 * true when it started — and the reason to rotate a registry credential is that
 * the old one has to stop working. Reading the store on each call is what makes
 * a rotation take effect without restarting anything.
 *
 * Refusals are two different situations and say which: an install with no
 * private registry at all (the common one — nothing is broken, there is just
 * nothing to serve), and an install that named a registry but never stored a
 * token for it (something is half-configured). The second has to stop the
 * install: installing without the token would resolve the private packages'
 * names against the public registry, which is how a dependency-confusion
 * package gets in.
 */
export class RegistryCredentials {
  constructor(
    private readonly host: string | null,
    private readonly store: SecretStore = getSecretStore(),
  ) {}

  async grant(): Promise<RegistryGrant | RegistryRefusal> {
    if (!this.host) {
      return {
        error: 'this install has no private package registry',
        remedy: 'set FLEETADLC_REGISTRY_HOST if you have one; otherwise nothing needs this endpoint',
        configured: false,
      };
    }

    const token = await this.store.get(registryTokenRef());
    if (!token) {
      return {
        error: `a registry is configured (${this.host}) but no token is stored for it`,
        remedy: missingTokenRemedy(envOr('FLEETADLC_SECRET_STORE', 'file')),
        configured: true,
      };
    }

    return { host: this.host, token, maxAgeSeconds: REGISTRY_TOKEN_MAX_AGE_SECONDS };
  }
}

/**
 * Where to put the token, for the store hostd reads. There is no `fleetadlc
 * secret` command, which this used to name. On the cloud host the store is
 * Secret Manager, and the file this named does not exist there; its secrets
 * are `fleet-<ref>` with the label the store lists by (gcp-secrets.ts).
 */
export function missingTokenRemedy(store: string): string {
  if (store === 'gcp') {
    return `store one in Secret Manager: printf '%s' "$REGISTRY_TOKEN" | gcloud secrets create fleet-${registryTokenRef()} --labels=fleet=secret --data-file=-`;
  }
  // The umask is inside the command: a mode written after it as prose was
  // pasted with it, and wrote the token, then `mode0600`, to `….secret,`, a
  // file nothing reads, readable by everyone.
  return `store one: (umask 077; printf '%s' "$REGISTRY_TOKEN" > "\${FLEETADLC_HOME:-$HOME/.fleetadlc}/secrets/${registryTokenRef()}.secret")`;
}

export function isRefusal(result: RegistryGrant | RegistryRefusal): result is RegistryRefusal {
  return 'error' in result;
}
