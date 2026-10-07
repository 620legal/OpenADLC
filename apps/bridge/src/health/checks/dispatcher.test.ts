import { describe, expect, it } from 'vitest';
import { defaultChecks } from '../index.js';
import { anythingDispatches, DISPATCHER_OFF_TITLE, dispatchModeOf, dispatcherCheck } from './dispatcher.js';

/**
 * A bridge started without the dispatcher leases nothing, while intake,
 * reviews and deploys still start from GitHub's events. The check is
 * what says so: a blocking card until the bridge is restarted with it.
 */

const NOW = new Date('2026-09-30T12:00:00.000Z');

describe('the dispatcher check', () => {
  it('fails, blocking, on a bridge started without the dispatcher, and says how to turn it on', async () => {
    const [result] = await dispatcherCheck({ dispatching: false, scripted: false, cloud: false }).run(NOW);

    expect(result).toMatchObject({ ok: false, severity: 'blocking', title: DISPATCHER_OFF_TITLE });
    expect(DISPATCHER_OFF_TITLE).toBe('The dispatcher isn’t running: nothing will start building');
    const detail = result!.ok === false ? result!.detail : '';
    expect(detail).toContain('FLEETADLC_DISPATCH_IN_BRIDGE=1');
    expect(detail).toContain('restart the bridge');
    expect(detail).toContain('Settings → Pause work');
    expect(result).toMatchObject({ action: { label: 'Restart OpenADLC', command: 'fleetadlc down && fleetadlc up' } });
  });

  it('on Cloud Run offers to apply the cloud install again, not a restart on the operator’s machine', async () => {
    const [result] = await dispatcherCheck({ dispatching: false, scripted: false, cloud: true }).run(NOW);

    expect(result).toMatchObject({ ok: false, severity: 'blocking', action: { label: 'Apply the cloud install again', command: 'fleetadlc cloud apply' } });
    const detail = result!.ok === false ? result!.detail : '';
    expect(detail).toContain('the cloud module sets FLEETADLC_DISPATCH_IN_BRIDGE=1');
    expect(detail).toContain('infra/gcp/main.tf');
    expect(detail).not.toContain('fleetadlc up');
  });

  it('reads the mode from the environment once, for the check and the pause route alike', () => {
    expect(dispatchModeOf(false, { K_SERVICE: 'fleetadlc-bridge' })).toEqual({ dispatching: false, scripted: false, cloud: true });
    expect(dispatchModeOf(false, { FLEETADLC_SCRIPTED_ENGINES: '1' })).toEqual({ dispatching: false, scripted: true, cloud: false });
    expect(anythingDispatches(dispatchModeOf(false, {}))).toBe(false);
    expect(anythingDispatches(dispatchModeOf(true, {}))).toBe(true);
    expect(anythingDispatches(dispatchModeOf(false, { FLEETADLC_SCRIPTED_ENGINES: '1' }))).toBe(true);
  });

  it('passes on a bridge that runs the dispatcher, and says so once when it comes back', async () => {
    expect(await dispatcherCheck({ dispatching: true, scripted: false, cloud: false }).run(NOW)).toEqual([
      { ok: true, fixed: expect.stringContaining('dispatcher is running again') },
    ]);
  });

  it('passes with scripted engines, where the integration suites dispatch', async () => {
    const [result] = await dispatcherCheck({ dispatching: false, scripted: true, cloud: false }).run(NOW);
    expect(result?.ok).toBe(true);
  });

  it('is registered with the other checks, given whether the bridge dispatches', async () => {
    const wiring = { config: { automationBot: null } as never, actors: {} as never, hostd: {} as never, webhookSetup: {} as never, repoSetup: {} as never };
    const off = defaultChecks({ ...wiring, dispatch: dispatchModeOf(false, {}) }).find((check) => check.id === 'dispatcher');
    const on = defaultChecks({ ...wiring, dispatch: dispatchModeOf(true, {}) }).find((check) => check.id === 'dispatcher');
    expect((await off!.run(NOW))[0]?.ok).toBe(false);
    expect((await on!.run(NOW))[0]?.ok).toBe(true);
  });
});
