import { describe, expect, it } from 'vitest';
import { LOCAL_DRIVER_TITLE, hostDriverCheck } from './host.js';

/**
 * Under the local driver a task runs as the operator's user and can read the
 * secret store; nothing on the board said so.
 */
describe('the host driver check', () => {
  const hostd = (answer: { ok: boolean; driver?: string }) => ({ health: async () => answer });

  it('raises a warning card while hostd runs tasks with the local driver', async () => {
    const [result] = await hostDriverCheck(hostd({ ok: true, driver: 'local' })).run(new Date());
    expect(result).toMatchObject({ ok: false, severity: 'warning', title: LOCAL_DRIVER_TITLE });
    expect(result && 'detail' in result ? result.detail : '').toContain('private key');
    expect(result && 'action' in result ? result.action : null).toMatchObject({ command: expect.stringContaining('fleetadlc init --driver docker') });
  });

  it('passes once hostd runs tasks in containers', async () => {
    expect(await hostDriverCheck(hostd({ ok: true, driver: 'docker' })).run(new Date())).toEqual([
      { ok: true, fixed: 'Tasks run in containers of their own now' },
    ]);
  });

  it('gives no answer while hostd does not, which is the hostd check’s card', async () => {
    const [result] = await hostDriverCheck(hostd({ ok: false })).run(new Date());
    expect(result).toMatchObject({ ok: null });
  });

  it('is not a step a person does in the walkthrough', () => {
    expect(hostDriverCheck(hostd({ ok: true })).steps).toEqual([]);
  });
});
