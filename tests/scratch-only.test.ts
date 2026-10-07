import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain script with no types; the suites import it as well.
import { whyNotScratch } from './scratch-only.mjs';

/**
 * The suites' guard let a suite carry on when no bridge answered, and never
 * looked at which database or FLEETADLC_HOME it would write to. With a real
 * install stopped by `fleetadlc down`, whose database keeps running, a suite
 * deleted its tasks and leases.
 */
const home = '/home/dev';
const SCRIPTED = { status: 'ok', scripted: true };

/** What `tests/scratch.sh env` exports. */
const scratch = {
  FLEETADLC_HOME: '/work/fleetadlc/.scratch/home',
  DATABASE_URL: 'postgres://fleetadlc:fleetadlc@127.0.0.1:57432/fleetadlc_db',
  FLEETADLC_BRIDGE_URL: 'http://127.0.0.1:57311',
  FLEETADLC_HOSTD_URL: 'http://127.0.0.1:57312',
  FLEETADLC_CONSOLE_URL: 'http://127.0.0.1:57300',
  FLEETADLC_INSTALL_ID: 'scratch',
};

/** CI's (.github/workflows/ci.yml): the default ports, a home under the workspace. */
const ci = {
  DATABASE_URL: 'postgres://fleetadlc:fleetadlc@127.0.0.1:5432/fleetadlc_db',
  FLEETADLC_BRIDGE_URL: 'http://127.0.0.1:47311',
  FLEETADLC_HOSTD_URL: 'http://127.0.0.1:47312',
  FLEETADLC_HOME: '/home/runner/work/fleetadlc/fleetadlc/.ci/fleetadlc-home',
};

describe('whether a suite may run', () => {
  it('lets a scratch install through', () => {
    expect(whyNotScratch({ env: scratch, health: SCRIPTED, home })).toBeNull();
  });

  it('lets CI’s install through, on the default ports', () => {
    expect(whyNotScratch({ env: ci, health: SCRIPTED, home })).toBeNull();
  });

  it('refuses when no bridge answers', () => {
    expect(whyNotScratch({ env: scratch, health: null, home })).toMatch(/no bridge answers at http:\/\/127\.0\.0\.1:57311/);
  });

  it('refuses a bridge that does not say it is scripted', () => {
    expect(whyNotScratch({ env: scratch, health: { status: 'ok' }, home })).toMatch(/is a real one/);
    expect(whyNotScratch({ env: scratch, health: { status: 'ok', scripted: false }, home })).toMatch(/is a real one/);
  });

  it.each(['FLEETADLC_BRIDGE_URL', 'FLEETADLC_HOSTD_URL', 'DATABASE_URL', 'FLEETADLC_HOME'])('refuses when %s is not set', (name) => {
    const env: Record<string, string> = { ...scratch };
    delete env[name];
    expect(whyNotScratch({ env, health: SCRIPTED, home })).toMatch(new RegExp(`^${name} is not set`));
  });

  it('refuses the real install’s home, however it is written', () => {
    for (const given of ['/home/dev/.fleetadlc', '/home/dev/.fleetadlc/', '~/.fleetadlc', '/home/dev/x/../.fleetadlc']) {
      expect(whyNotScratch({ env: { ...scratch, FLEETADLC_HOME: given }, health: SCRIPTED, home })).toMatch(/the real install's home/);
    }
  });
});
