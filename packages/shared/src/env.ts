/**
 * `FLEETADLC_*` settings, adopted under their `OPENADLC_*` names. The rename
 * to FleetADLC read no `FLEET_*` at all, so an install started with only its
 * old names came up as a new, empty one — the default home, no secrets — and
 * every variable had to be renamed by hand before the upgrade. This time the
 * old names keep working: each entry point calls this first, the value moves
 * to the new name when the new name is unset (a set `OPENADLC_*` always
 * wins), and `NEXT_PUBLIC_FLEETADLC_*` moves the same way for the console.
 * Returns the old names it adopted, for the one line that says to rename.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = [];
  for (const name of Object.keys(env)) {
    if (!/^(NEXT_PUBLIC_)?FLEETADLC_/.test(name)) continue;
    const value = env[name];
    if (value === undefined) continue;
    const renamed = name.replace('FLEETADLC_', 'OPENADLC_');
    if (env[renamed] !== undefined) continue;
    env[renamed] = value;
    adopted.push(name);
  }
  return adopted.sort();
}

/** What an entry point says, once, when any setting still wears its old name. */
export function legacyEnvNote(adopted: string[]): string | null {
  if (adopted.length === 0) return null;
  return `read under their old names: ${adopted.join(', ')} — rename each FLEETADLC_* setting to OPENADLC_* where it is set (docs/upgrading-from-fleet.md#from-fleetadlc-to-openadlc)`;
}

export function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * When a lease the bridge or hostd writes expires: `OPENADLC_LEASE_HOURS`
 * (twelve by default) after `now`. That covers a lease put back in task as
 * its work ends and a stacked build's lease. The dispatcher and a retry read
 * the same variable through their own options, so a test can set theirs.
 */
export function leaseExpiryFrom(now = new Date()): Date {
  return new Date(now.getTime() + envInt('OPENADLC_LEASE_HOURS', 12) * 3600 * 1000);
}

export function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * The driver hostd runs tasks under: `local` when unset, and otherwise exactly
 * `local` or `docker`, in any case and with spaces around it. Anything else is
 * refused. It used to mean `local`, the driver with no isolation at all, so a
 * typo in install.json ran every session on the host as hostd's own user,
 * where the install's secrets are.
 */
export function hostdDriverFromEnv(): 'local' | 'docker' {
  const raw = process.env.OPENADLC_HOSTD_DRIVER;
  if (raw === undefined || raw === '') return 'local';
  const driver = raw.trim().toLowerCase();
  if (driver === 'local' || driver === 'docker') return driver;
  throw new Error(`OPENADLC_HOSTD_DRIVER is ${JSON.stringify(raw)}; it must be "docker" or "local"`);
}

/** Default ports are deliberately uncommon so a local install collides with nothing. */
export const DEFAULT_PORTS = {
  console: 47300,
  bridge: 47311,
  hostd: 47312,
  postgres: 47432,
} as const;
