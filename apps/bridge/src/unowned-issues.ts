import { settings } from '@fleetadlc/db';

/**
 * Open issues OpenADLC will not take on its own, by repository.
 *
 * The intake sweep sends an unlabeled issue to intake only when OpenADLC acts
 * for its author. One filed by somebody it does not — testbed's #3 and #7
 * were filed by an old crew account with no access left — was skipped without
 * a word, nothing built it, and intake still counted its files against every
 * new request. So the sweep writes them here, Needs you asks a person to send
 * them to intake, ignore them or close them, and intake's overlap check leaves
 * them out until somebody has.
 */
export interface UnownedIssue {
  number: number;
  title: string;
  url: string;
  author: string | null;
}

const UNOWNED_KEY = 'unownedIssues';

export function unownedFrom(stored: string | null): Record<string, UnownedIssue[]> {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, UnownedIssue[]> = {};
    for (const [repo, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      out[repo] = list.filter(
        (one): one is UnownedIssue =>
          Boolean(one) && typeof (one as UnownedIssue).number === 'number' && typeof (one as UnownedIssue).title === 'string',
      );
    }
    return out;
  } catch {
    return {};
  }
}

/** Where the lists are kept: the install's settings, or a test's. */
export interface UnownedStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export const settingsStore: UnownedStore = {
  read: () => settings.getSetting(UNOWNED_KEY),
  write: (value) => settings.setSetting(UNOWNED_KEY, value, 'bridge'),
};

export async function readUnowned(store: UnownedStore = settingsStore): Promise<Record<string, UnownedIssue[]>> {
  return unownedFrom(await store.read().catch(() => null));
}

/** The repository's list, replaced as the sweep found it. True when it changed. */
export async function recordUnowned(repoName: string, list: readonly UnownedIssue[], store: UnownedStore = settingsStore): Promise<boolean> {
  const all = await readUnowned(store);
  const was = all[repoName] ?? [];
  const sorted = [...list].sort((a, b) => a.number - b.number);
  if (JSON.stringify(was.map((one) => one.number)) === JSON.stringify(sorted.map((one) => one.number))) return false;
  if (sorted.length === 0) delete all[repoName];
  else all[repoName] = sorted;
  await store.write(JSON.stringify(all));
  return true;
}

/** Takes issues off a repository's list, once a person has decided about them. */
export async function forgetUnowned(repoName: string, numbers: readonly number[], store: UnownedStore = settingsStore): Promise<void> {
  const all = await readUnowned(store);
  const was = all[repoName] ?? [];
  const left = was.filter((one) => !numbers.includes(one.number));
  if (left.length === was.length) return;
  if (left.length === 0) delete all[repoName];
  else all[repoName] = left;
  await store.write(JSON.stringify(all));
}
