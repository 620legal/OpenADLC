import { describe, expect, it } from 'vitest';
import { GitHubApiError, signingKeyRef, type SecretStore } from '@openadlc/github';
import { ensureSigningKeyRegistered, revokeGate, settledSigningKey, signingKeyWarning } from './signing-keys.js';

/**
 * A bot's signing key has to be one its GitHub account knows, or its commits
 * read Unverified. The key was uploaded only when it was made; every upload was
 * refused (the app lacked "SSH signing keys"), and reconnecting tried nothing
 * because a key already existed.
 *
 * Registering also has to be idempotent: two registrations at once — a connect
 * and the scheduled check — each generated a fresh pair and uploaded it under
 * the same title, and every pair but the stored one became "a signing key
 * OpenADLC did not register" on the board.
 */

const PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStoredKeyStoredKey openadlc-atlas';

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

function github(
  known: { id: number; key: string; title?: string }[],
  refuse?: { list?: GitHubApiError; upload?: GitHubApiError; delete?: GitHubApiError },
) {
  const uploads: { title: string; key: string }[] = [];
  const deleted: number[] = [];
  let keys = known.map((key) => ({ title: 'openadlc', ...key }));
  return {
    uploads,
    deleted,
    client: {
      async listSshSigningKeys() {
        if (refuse?.list) throw refuse.list;
        return [...keys];
      },
      async uploadSshSigningKey(title: string, key: string) {
        if (refuse?.upload) throw refuse.upload;
        uploads.push({ title, key });
        keys = [...keys, { id: 42, title, key }];
        return 42;
      },
      async deleteSshSigningKey(id: number) {
        if (refuse?.delete) throw refuse.delete;
        deleted.push(id);
        keys = keys.filter((key) => key.id !== id);
      },
    },
  };
}

const derive = () => PUBLIC;

describe('registering a bot’s signing key', () => {
  it('uploads the key the bot already has when its account does not know it', async () => {
    const store = memory({ [signingKeyRef('openadlc-atlas-janedoe')]: 'PRIVATE' });
    const { client, uploads } = github([]);

    const result = await ensureSigningKeyRegistered({ name: 'openadlc-atlas-janedoe', store, client, derive });

    expect(result).toEqual({ state: 'uploaded', keyId: 42 });
    expect(uploads).toEqual([{ title: 'openadlc-openadlc-atlas-janedoe', key: PUBLIC }]);
  });

  it('uploads nothing when the account already has it, whatever its comment says', async () => {
    const store = memory({ [signingKeyRef('openadlc-atlas-janedoe')]: 'PRIVATE' });
    const { client, uploads } = github([{ id: 7, key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStoredKeyStoredKey' }]);

    expect(await ensureSigningKeyRegistered({ name: 'openadlc-atlas-janedoe', store, client, derive })).toEqual({
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
      generate: () => ({ privateKey: 'NEW-PRIVATE', publicKey: 'ssh-ed25519 AAAANEW openadlc-qa' }),
    });

    expect(store.data.get(signingKeyRef('qa'))).toBe('NEW-PRIVATE');
    expect(uploads).toEqual([{ title: 'openadlc-qa', key: 'ssh-ed25519 AAAANEW openadlc-qa' }]);
  });

  it('says what the app needs when GitHub refuses, instead of claiming it uploaded', async () => {
    const store = memory({ [signingKeyRef('openadlc-atlas-janedoe')]: 'PRIVATE' });
    const refused = new GitHubApiError(403, '/user/ssh_signing_keys', 'Resource not accessible by integration');
    const { client } = github([], { list: refused });

    const result = await ensureSigningKeyRegistered({ name: 'openadlc-atlas-janedoe', store, client, derive });

    expect(result.state).toBe('refused');
    expect(result.state === 'refused' && result.warning).toContain('"SSH signing keys" permission');
    expect(result.state === 'refused' && result.warning).toContain('connect openadlc-atlas-janedoe again');
  });

  it('passes on any other refusal in GitHub’s words', () => {
    expect(signingKeyWarning('qa', new Error('socket hang up'))).toBe("GitHub would not register qa's signing key: socket hang up");
  });
});

describe('registering again, after a retry or a race left its mark', () => {
  it('removes its own stale upload — the bot’s title on a key that is not the bot’s key — before uploading', async () => {
    const store = memory({ [signingKeyRef('openadlc-atlas-janedoe')]: 'PRIVATE' });
    const { client, uploads, deleted } = github([{ id: 7, key: 'ssh-ed25519 AAAAOLD', title: 'openadlc-openadlc-atlas-janedoe' }]);

    const result = await ensureSigningKeyRegistered({ name: 'openadlc-atlas-janedoe', store, client, derive });

    expect(deleted).toEqual([7]);
    expect(result).toEqual({ state: 'uploaded', keyId: 42 });
    expect(uploads).toEqual([{ title: 'openadlc-openadlc-atlas-janedoe', key: PUBLIC }]);
  });

  it('removes a stale duplicate even when the current key is already registered', async () => {
    const store = memory({ [signingKeyRef('openadlc-atlas-janedoe')]: 'PRIVATE' });
    const { client, uploads, deleted } = github([
      { id: 7, key: 'ssh-ed25519 AAAAOLD', title: 'openadlc-openadlc-atlas-janedoe' },
      { id: 8, key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStoredKeyStoredKey', title: 'openadlc-openadlc-atlas-janedoe' },
    ]);

    const result = await ensureSigningKeyRegistered({ name: 'openadlc-atlas-janedoe', store, client, derive });

    expect(deleted).toEqual([7]);
    expect(result).toEqual({ state: 'registered', keyId: 8 });
    expect(uploads).toEqual([]);
  });

  it('leaves other titles alone: another seat’s key and a person’s are not OpenADLC’s to remove', async () => {
    const store = memory({ [signingKeyRef('openadlc-atlas-janedoe')]: 'PRIVATE' });
    const { client, deleted } = github([
      { id: 7, key: 'ssh-ed25519 AAAAOTHERSEAT', title: 'openadlc-qa' },
      { id: 8, key: 'ssh-ed25519 AAAALAPTOP', title: 'laptop' },
    ]);

    await ensureSigningKeyRegistered({ name: 'openadlc-atlas-janedoe', store, client, derive });

    expect(deleted).toEqual([]);
  });

  it('still uploads when a stale key would not delete: the card now offers Revoke and Dismiss for what is left', async () => {
    const store = memory({ [signingKeyRef('qa')]: 'PRIVATE' });
    const refused = new GitHubApiError(403, '/user/ssh_signing_keys/7', 'Resource not accessible by integration');
    const { client, uploads } = github([{ id: 7, key: 'ssh-ed25519 AAAAOLD', title: 'openadlc-qa' }], { delete: refused });

    const result = await ensureSigningKeyRegistered({ name: 'qa', store, client, derive });

    expect(result).toEqual({ state: 'uploaded', keyId: 42 });
    expect(uploads).toEqual([{ title: 'openadlc-qa', key: PUBLIC }]);
  });

  it('reads "key is already in use" as registered: a racing registration landed the same key first', async () => {
    const store = memory({ [signingKeyRef('qa')]: 'PRIVATE' });
    const inUse = new GitHubApiError(422, '/user/ssh_signing_keys', 'Validation Failed: key is already in use');
    // Empty on the first list, there on the second: what a race looks like.
    const lists: { id: number; title: string; key: string }[][] = [[], [{ id: 9, title: 'openadlc-qa', key: PUBLIC }]];
    const client = {
      async listSshSigningKeys() {
        return lists.shift() ?? [];
      },
      async uploadSshSigningKey(): Promise<number> {
        throw inUse;
      },
      async deleteSshSigningKey() {},
    };

    expect(await ensureSigningKeyRegistered({ name: 'qa', store, client, derive })).toEqual({ state: 'registered', keyId: 9 });
  });

  it('registers the stored key when another registration wrote the store first, not its own losing pair', async () => {
    const store = memory();
    const wrote = store.set.bind(store);
    // The other registration's write lands right after ours: last write wins
    // in the store, and both registrations must then upload that one.
    store.set = async (ref, value) => {
      await wrote(ref, value);
      await wrote(ref, 'WINNER-PRIVATE');
    };
    const { client, uploads } = github([]);

    const result = await ensureSigningKeyRegistered({
      name: 'qa',
      store,
      client,
      generate: () => ({ privateKey: 'LOSER-PRIVATE', publicKey: 'ssh-ed25519 AAAALOSER openadlc-qa' }),
      derive: (privateKey) => (privateKey === 'WINNER-PRIVATE' ? 'ssh-ed25519 AAAAWINNER openadlc-qa' : 'ssh-ed25519 AAAALOSER openadlc-qa'),
    });

    expect(result).toEqual({ state: 'uploaded', keyId: 42 });
    expect(uploads).toEqual([{ title: 'openadlc-qa', key: 'ssh-ed25519 AAAAWINNER openadlc-qa' }]);
  });
});

describe('the key the scheduled check registers, as the store settled', () => {
  // The check's reader is this function (health/index.ts), so these are the
  // check path's convergence: without the re-read it uploads its own losing
  // pair under the seat's title, beside the connect's.
  it('is the other writer’s when that write lands after ours and before the re-read', async () => {
    const store = memory();
    const read = store.get.bind(store);
    let reads = 0;
    store.get = async (ref) => {
      reads += 1;
      if (reads === 2) store.data.set(ref, 'CONNECT-PRIVATE');
      return read(ref);
    };

    const settled = await settledSigningKey('qa', store, () => ({ privateKey: 'CHECK-PRIVATE', publicKey: 'ssh-ed25519 AAAACHECK openadlc-qa' }));

    expect(settled).toEqual({ privateKey: 'CONNECT-PRIVATE', publicKey: null });
    expect(store.data.get(signingKeyRef('qa'))).toBe('CONNECT-PRIVATE');
  });

  it('is its own pair, public half included, when nobody else wrote', async () => {
    const store = memory();
    const pair = { privateKey: 'CHECK-PRIVATE', publicKey: 'ssh-ed25519 AAAACHECK openadlc-qa' };
    expect(await settledSigningKey('qa', store, () => pair)).toEqual(pair);
    expect(store.data.get(signingKeyRef('qa'))).toBe('CHECK-PRIVATE');
  });

  it('is the stored key when there is one, and makes no pair', async () => {
    const store = memory({ [signingKeyRef('qa')]: 'STORED-PRIVATE' });
    const generate = () => {
      throw new Error('no pair should be made');
    };
    expect(await settledSigningKey('qa', store, generate)).toEqual({ privateKey: 'STORED-PRIVATE', publicKey: null });
  });
});

describe('whether a bot’s sign-in may delete a key, told before the card offers Revoke', () => {
  it('lets a device-flow sign-in delete while the app holds "SSH signing keys"', () => {
    expect(revokeGate('refresh', [], false)).toBeNull();
  });

  it('names the app permission a device-flow sign-in is missing', () => {
    expect(revokeGate('refresh', [], true)).toContain('SSH signing keys');
  });

  it('lets a static token delete only with the admin:ssh_signing_key scope', () => {
    expect(revokeGate('static', ['repo', 'admin:ssh_signing_key'], false)).toBeNull();
    expect(revokeGate('static', ['repo'], false)).toContain('admin:ssh_signing_key');
    // A fine-grained token records no scopes, so nothing says it may delete.
    expect(revokeGate('static', [], false)).toContain('admin:ssh_signing_key');
  });

  it('says so when the bot holds no sign-in at all', () => {
    expect(revokeGate(null, [], false)).toContain('no working sign-in');
  });
});
