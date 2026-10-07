import { describe, expect, it, vi } from 'vitest';
import { DeployKnowledge, hasDeployWorkflow, shipsByMerging, type WorkflowLister } from './deploys.js';

/**
 * Whether merging is shipping: fleetadlc-testbed deploys nothing, and its board's
 * Ship column said "Deploys what was approved · waits for you" over a stage
 * that never happens there.
 */

/** A client that lists these workflows, or fails; `asked` counts the calls. */
function lister(workflows: { name?: string; path?: string }[] | Error): WorkflowLister & { asked: () => number } {
  const request = vi.fn(async () => {
    if (workflows instanceof Error) throw workflows;
    return { workflows };
  });
  return { request: request as unknown as WorkflowLister['request'], asked: () => request.mock.calls.length };
}

describe('whether a repository ships by merging', () => {
  it('does when nothing deploys, and does not once a deploy workflow is there', async () => {
    expect(await shipsByMerging(lister([{ name: 'ci', path: '.github/workflows/ci.yml' }]), 'janedoe/fleetadlc-testbed')).toBe(true);
    expect(await shipsByMerging(lister([{ name: 'Deploy', path: '.github/workflows/deploy-testing.yml' }]), 'janedoe/fleetadlc-testbed')).toBe(false);
    expect(hasDeployWorkflow([{ name: 'deploy-testing' }])).toBe(true);
  });

  it('reads every page of a repository’s workflows, and guesses nothing when one cannot be read', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `job-${i}`, path: `.github/workflows/job-${i}.yml` }));
    const paged = (second: { name?: string; path?: string }[] | Error): WorkflowLister => ({
      request: (async (_method: string, path: string) => {
        if (path.endsWith('&page=1')) return { workflows: many };
        if (second instanceof Error) throw second;
        return { workflows: second };
      }) as WorkflowLister['request'],
    });
    expect(await shipsByMerging(paged([{ name: 'Deploy', path: '.github/workflows/deploy-testing.yml' }]), 'janedoe/fleetadlc-testbed')).toBe(false);
    expect(await shipsByMerging(paged([{ name: 'lint', path: '.github/workflows/lint.yml' }]), 'janedoe/fleetadlc-testbed')).toBe(true);
    expect(await shipsByMerging(paged(new Error('502')), 'janedoe/fleetadlc-testbed')).toBeNull();
  });

  it('is not guessed when GitHub cannot be asked', async () => {
    expect(await shipsByMerging(null, 'janedoe/fleetadlc-testbed')).toBeNull();
    expect(await shipsByMerging(lister(new Error('502')), 'janedoe/fleetadlc-testbed')).toBeNull();
  });

  it('answers from the choice, with or without a workflow, and does not ask GitHub for an explicit one', async () => {
    const withWorkflow = lister([{ name: 'deploy-testing', path: '.github/workflows/deploy-testing.yml' }]);
    const without = lister([{ name: 'ci', path: '.github/workflows/ci.yml' }]);

    // The choice "No testing deploy" ('none') ships by merging even when the
    // workflow file is there and skips; "Has a testing deploy" ('has') does
    // not, even when the file is absent.
    expect(await shipsByMerging(withWorkflow, 'janedoe/fleetadlc', 'none')).toBe(true);
    expect(await shipsByMerging(without, 'janedoe/fleetadlc', 'none')).toBe(true);
    expect(await shipsByMerging(withWorkflow, 'janedoe/fleetadlc', 'has')).toBe(false);
    expect(await shipsByMerging(without, 'janedoe/fleetadlc', 'has')).toBe(false);
    expect(withWorkflow.asked()).toBe(0);
    expect(without.asked()).toBe(0);

    expect(await shipsByMerging(without, 'janedoe/fleetadlc', 'automatic')).toBe(true);
    expect(await shipsByMerging(withWorkflow, 'janedoe/fleetadlc', 'automatic')).toBe(false);
    expect(without.asked()).toBe(1);
    expect(withWorkflow.asked()).toBe(1);
  });

  it('does not remember an explicit choice as what automatic would have asked', async () => {
    const client = lister([{ name: 'deploy-testing', path: '.github/workflows/deploy-testing.yml' }]);
    const known = new DeployKnowledge(async () => client);

    expect(await known.shipsByMerging('janedoe/fleetadlc', 'none')).toBe(true);
    expect(await known.shipsByMerging('janedoe/fleetadlc', 'has')).toBe(false);
    expect(client.asked()).toBe(0);
    // Automatic still asks: the explicit answers were not stored under the name.
    expect(await known.shipsByMerging('janedoe/fleetadlc', 'automatic')).toBe(false);
    expect(client.asked()).toBe(1);
  });

  it('is remembered for a while for the board, and asked again after', async () => {
    let now = 0;
    const client = lister([]);
    const known = new DeployKnowledge(async () => client, 60_000, () => now);

    expect(await known.shipsByMerging('janedoe/fleetadlc-testbed')).toBe(true);
    now = 30_000;
    expect(await known.shipsByMerging('janedoe/fleetadlc-testbed')).toBe(true);
    expect(client.asked()).toBe(1);
    now = 61_000;
    await known.shipsByMerging('janedoe/fleetadlc-testbed');
    expect(client.asked()).toBe(2);
  });
});
