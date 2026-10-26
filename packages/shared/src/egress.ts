/**
 * The names a cloud host's tasks may reach beyond the module's list.
 *
 * A cloud host's tasks leave only through its egress proxy, which refuses a
 * name off its allowlist: `allowed_egress_domains` in `infra/gcp/main.tf`,
 * the operator's `extra_allowed_domains`, and the names an admin allows in
 * Settings (`egressExtraHosts`), which hostd writes to a file the proxy reads
 * and has it read again. Only a person in Settings adds one. A repository's
 * own `.github/openadlc.yml` never does: a merged file naming a host would
 * otherwise open the host's egress to whatever name it chose.
 *
 * Every name matches itself and everything under it, as the module's own do:
 * the proxy is given each with a leading dot.
 */

/** What the egress proxy says of one name a task would ask it for (hostd's `GET /egress`). */
export type EgressAnswer =
  | { host: string; allowed: true }
  | { host: string; allowed: false; status: number }
  | { host: string; allowed: null; reason: string };

export interface EgressReport {
  /** Whether this host's tasks leave through an egress proxy at all. A laptop's do not, and nothing is refused there. */
  proxied: boolean;
  /**
   * Whether the proxy reads Settings' list, which hostd writes for it: a host
   * whose cloud-init is from before the list does not, until the module is
   * applied again. Absent from a hostd older than the list.
   */
  settingsList?: boolean;
  hosts: EgressAnswer[];
}

/** How many names Settings may hold: each is a way out of the host. */
export const MAX_EGRESS_HOSTS = 50;

/**
 * How many names one ask of hostd's `GET /egress` may carry: each is a
 * connection through the proxy, all at once. hostd refuses more, and the
 * testing-egress check asks in batches of this many, so every testing host
 * gets an answer: hostd used to keep the first 20 and drop the rest without
 * a word, and a host dropped that way raised no card.
 */
export const EGRESS_NAMES_PER_ASK = 20;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Why a name cannot be allowed, or null when it can: a bare host name, in
 * lower case, of two labels or more, with no scheme, port or path. An address
 * is refused, as the proxy refuses one whatever it is called; so is a single
 * label, which would open a whole top-level domain.
 */
export function egressHostProblem(name: string): string | null {
  if (!name) return 'give a host name, such as testing.example.com';
  if (/[/:@\s]/.test(name)) return `${name} is not a bare host name: give it with no scheme, port or path, such as testing.example.com`;
  if (name.length > 253) return `${name} is longer than a host name can be`;
  const labels = name.split('.');
  if (labels.length < 2) return `${name} is a single label, which would let tasks reach every name under it: give the whole host name`;
  if (!labels.every((label) => LABEL.test(label))) return `${name} is not a host name: letters, digits and hyphens between dots`;
  if (labels.every((label) => /^\d+$/.test(label))) return `${name} is an address, which the egress proxy refuses whatever is listed: give the environment's host name`;
  return null;
}

/** A name as a person typed it, as it is kept: trimmed, lower case, a leading dot or `https://` and a trailing path taken off. */
export function normalEgressHost(typed: string): string {
  let name = typed.trim().toLowerCase();
  name = name.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '');
  return name.replace(/^\.+/, '').replace(/\.+$/, '');
}

/** The stored list, one name after another and comma-separated, as `egressExtraHosts` holds it. */
export function parseEgressHosts(stored: string | null | undefined): string[] {
  return [...new Set((stored ?? '').split(',').map((one) => one.trim().toLowerCase()).filter(Boolean))];
}

/** The listed name that lets `host` through, by the proxy's rule: the name itself or any name under it. Null when none does. */
export function egressListAllows(list: readonly string[], host: string): string | null {
  const name = host.toLowerCase();
  return list.find((listed) => name === listed || name.endsWith(`.${listed}`)) ?? null;
}

/**
 * The list without a name another one already covers. The proxy warns of a
 * name under another in the same list and drops it, so it is dropped here,
 * where the list is written.
 */
export function withoutCoveredHosts(list: readonly string[]): string[] {
  const unique = [...new Set(list)];
  return unique.filter((name) => !unique.some((other) => other !== name && name.endsWith(`.${other}`)));
}
