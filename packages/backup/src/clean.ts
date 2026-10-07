/**
 * Whether an install is clean: nothing set up that a restore would have to
 * decide about.
 *
 * Restoring onto a clean install is putting things where there is nothing,
 * which is what the walkthrough's first step does. Restoring into one that is
 * set up means deciding, thing by thing, whether the archive or the install
 * wins — whose App key, whose account for the builder, which of two
 * repositories' settings — so that is done from Settings → Backup, which lays
 * the two side by side first (`compare.ts`). The walkthrough's restore says
 * where to go instead.
 *
 * Clean is four facts, each a thing a person sets up in the walkthrough: no
 * GitHub App, no repository, no connected bot, no model account. Settings
 * alone — an organization typed in, an email — do not count: a restore
 * replaces them, and nothing depends on them yet.
 */

export const NOT_CLEAN =
  'This install is already set up: restore into it from Settings → Backup, which compares the backup with this install first.';

export interface InstallFacts {
  /** A client id (stored or in the environment), or the App's private key. */
  appConfigured: boolean;
  repositories: string[];
  /** Bots that hold a GitHub credential, by name. */
  connectedBots: string[];
  /** Model accounts, by label. */
  modelAccounts: string[];
}

export interface Cleanliness {
  clean: boolean;
  /** What is set up, in words, when it is not clean. */
  setUp: string[];
}

/** One of a kind by name, several by count: what a sentence can hold. */
function named(items: readonly string[], one: (name: string) => string, many: string): string[] {
  if (items.length === 0) return [];
  return [items.length === 1 ? one(items[0] as string) : `${items.length} ${many}`];
}

export function cleanliness(facts: InstallFacts): Cleanliness {
  const setUp = [
    ...(facts.appConfigured ? ['the GitHub App'] : []),
    ...named(facts.repositories, (repo) => `the repository ${repo}`, 'repositories'),
    ...named(facts.connectedBots, (bot) => `${bot}, connected to GitHub`, 'bots connected to GitHub'),
    ...named(facts.modelAccounts, (account) => `the model account ${account}`, 'model accounts'),
  ];
  return { clean: setUp.length === 0, setUp };
}
