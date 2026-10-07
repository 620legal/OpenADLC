import { describe, expect, it } from 'vitest';
import { GitHubApiError, signingKeyRef, type SecretStore } from '@fleetadlc/github';
import { ensureSigningKeyRegistered, signingKeyWarning } from './signing-keys.js';

/**
 * A bot's signing key has to be one its GitHub account knows, or its commits
 * read Unverified. The key was uploaded only when it was made; every upload was
 * refused (the app lacked "SSH signing keys"), and reconnecting tried nothing
 * because a key already existed.
 */

const PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStoredKeyStoredKey fleetadlc-atlas';

function memory(initial: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(ref) {
      return data.get(ref) ?? null;
    },
    async set(ref, value) {
      data.set(ref, value);
    },
    async delete(ref) {
      data.delete(ref);
    },
    async list(prefix = '') {
      return [...data.keys()].filter((ref) => ref.startsWith(prefix)).sort();
    },
  };
}

function github(known: { id: number; key: string }[], refuse?: GitHubApiError) {
  const uploads: { title: string; key: string }[] = [];
  return {
    uploads,
    client: {
      async listSshSigningKeys() {
        if (refuse) throw refuse;
        return known.map((key) => ({ ...key, title: 'fleetadlc' }));
      },
      async uploadSshSigningKey(title: string, key: string) {
        uploads.push({ title, key });
        return 42;
      },
    },
  };
}

const derive = () => PUBLIC;

describe('registering a bot’s signing key', () => {
  it('uploads the key the bot already has when its account does not know it', async () => {
    const store = memory({ [signingKeyRef('fleetadlc-atlas-janedoe')]: 'PRIVATE' });
    const { client, uploads } = github([]);

    const result = await ensureSigningKeyRegistered({ name: 'fleetadlc-atlas-janedoe', store, client, derive });

    expect(result).toEqual({ state: 'uploaded', keyId: 42 });
    expect(uploads).toEqual([{ title: 'fleetadlc-fleetadlc-atlas-janedoe', key: PUBLIC }]);
  });

  it('uploads nothing when the account already has it, whatever its comment says', async () => {
    const store = memory({ [signingKeyRef('fleetadlc-atlas-janedoe')]: 'PRIVATE' });
    const { client, uploads } = github([{ id: 7, key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStoredKeyStoredKey' }]);

    expect(await ensureSigningKeyRegistered({ name: 'fleetadlc-atlas-janedoe', store, client, derive })).toEqual({
      state: 'registered',
      keyId: 7,
    });
    expect(uploads).toEqual([]);
  });

  it('makes a key when there is none, keeps it, and uploads it', async () => {
    const store = memory();
    const { client, uploads } = github([]);

    await ensureSigningKeyRegistered({
      name: 'qa',
      store,
      client,
      generate: () => ({ privateKey: 'NEW-PRIVATE', publicKey: 'ssh-ed25519 AAAANEW fleetadlc-qa' }),
    });

    expect(store.data.get(signingKeyRef('qa'))).toBe('NEW-PRIVATE');
    expect(uploads).toEqual([{ title: 'fleetadlc-qa', key: 'ssh-ed25519 AAAANEW fleetadlc-qa' }]);
  });

  it('says what the app needs when GitHub refuses, instead of claiming it uploaded', async () => {
    const store = memory({ [signingKeyRef('fleetadlc-atlas-janedoe')]: 'PRIVATE' });
    const refused = new GitHubApiError(403, '/user/ssh_signing_keys', 'Resource not accessible by integration');
    const { client } = github([], refused);

    const result = await ensureSigningKeyRegistered({ name: 'fleetadlc-atlas-janedoe', store, client, derive });

    expect(result.state).toBe('refused');
    expect(result.state === 'refused' && result.warning).toContain('"SSH signing keys" permission');
    expect(result.state === 'refused' && result.warning).toContain('connect fleetadlc-atlas-janedoe again');
  });

  it('passes on any other refusal in GitHub’s words', () => {
    expect(signingKeyWarning('qa', new Error('socket hang up'))).toBe("GitHub would not register qa's signing key: socket hang up");
  });
});
