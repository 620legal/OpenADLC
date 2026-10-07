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
 * When a lease the bridge or hostd writes expires: `FLEETADLC_LEASE_HOURS`
 * (twelve by default) after `now`. That covers a lease put back in task as
 * its work ends and a stacked build's lease. The dispatcher and a retry read
 * the same variable through their own options, so a test can set theirs.
 */
export function leaseExpiryFrom(now = new Date()): Date {
  return new Date(now.getTime() + envInt('FLEETADLC_LEASE_HOURS', 12) * 3600 * 1000);
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
  const raw = process.env.FLEETADLC_HOSTD_DRIVER;
  if (raw === undefined || raw === '') return 'local';
  const driver = raw.trim().toLowerCase();
  if (driver === 'local' || driver === 'docker') return driver;
  throw new Error(`FLEETADLC_HOSTD_DRIVER is ${JSON.stringify(raw)}; it must be "docker" or "local"`);
}

/** Default ports are deliberately uncommon so a local install collides with nothing. */
export const DEFAULT_PORTS = {
  console: 47300,
  bridge: 47311,
  hostd: 47312,
  postgres: 47432,
} as const;
