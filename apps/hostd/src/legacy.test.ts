import { describe, expect, it } from 'vitest';
import type { DockerResult } from './drivers/docker.js';
import { retireSeatContainers } from './legacy.js';

interface Fake {
  labels?: Record<string, string> | null;
  image?: string;
  networks?: string[];
}

/** Docker as a script: which containers exist, and whose. */
function daemon(containers: Record<string, Record<string, string> | null | Fake>) {
  const calls: string[][] = [];
  const docker = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'inspect') {
      const name = args[2] ?? '';
      if (!(name in containers)) return { code: 1, stdout: '', stderr: 'no such container' };
      const given = containers[name];
      const fake: Fake = given && ('labels' in given || 'image' in given || 'networks' in given) ? (given as Fake) : { labels: given as Record<string, string> | null };
      const entry = {
        Config: { Labels: fake.labels ?? null, Image: fake.image ?? 'example/other:1' },
        NetworkSettings: { Networks: Object.fromEntries((fake.networks ?? ['bridge']).map((network) => [network, {}])) },
      };
      return { code: 0, stdout: JSON.stringify([entry]), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, docker };
}

describe('retiring each seat’s container from before a task had its own', () => {
  it('removes the container, its sidecar and its network for a seat with nothing running, and keeps a busy one', async () => {
    const { calls, docker } = daemon({
      'bot-builder': { 'fleetadlc.install': 'default' },
      'bot-builder-db': { 'fleetadlc.install': 'default' },
      // From before installs were named: the default install's, by its seat label.
      'bot-intake': { 'fleet.login': 'none' },
      'bot-lead-reviewer': { 'fleetadlc.install': 'default' },
    });

    const result = await retireSeatContainers({
      docker,
      install: 'default',
      botPrefix: 'bot-',
      networkPrefix: 'fleetadlc-bot',
      seats: [
        { name: 'builder', busy: false },
        { name: 'intake', busy: false },
        // A task started on the old model is still in it.
        { name: 'lead-reviewer', busy: true },
        { name: 'qa', busy: false },
      ],
    });

    expect(result).toEqual({ retired: ['builder', 'intake'], kept: [{ seat: 'lead-reviewer', why: 'it has a task running in it' }] });
    const removed = calls.filter((args) => args[0] === 'rm').map((args) => args.at(-1));
    expect(removed).toEqual(['bot-builder', 'bot-builder-db', 'bot-intake']);
    expect(calls).toContainEqual(['rm', '-f', '-v', 'bot-builder']);
    const networks = calls.filter((args) => args[0] === 'network').map((args) => args.at(-1));
    // And the network's name from before the rename.
    expect(networks).toEqual(['fleetadlc-bot-builder', 'fleet-bot-builder', 'fleetadlc-bot-intake', 'fleet-bot-intake']);
  });

  it('never removes another install’s container that shares the name', async () => {
    const { calls, docker } = daemon({ 'bot-builder': { 'fleetadlc.install': 'compose-fleetadlc' } });

    const result = await retireSeatContainers({
      docker,
      install: 'default',
      botPrefix: 'bot-',
      networkPrefix: 'fleetadlc-bot',
      seats: [{ name: 'builder', busy: false }],
    });

    expect(result.kept).toEqual([{ seat: 'builder', why: 'it belongs to install compose-fleetadlc' }]);
    expect(calls.some((args) => args[0] === 'rm' || args[0] === 'network')).toBe(false);
  });

  it('keeps an unlabelled container that only shares a seat’s name, and says how to remove it', async () => {
    const lines: string[] = [];
    const { calls, docker } = daemon({ 'bot-qa': null, 'bot-qa-db': { networks: ['bridge'] } });

    const result = await retireSeatContainers({
      docker,
      install: 'default',
      botPrefix: 'bot-',
      networkPrefix: 'fleetadlc-bot',
      seats: [{ name: 'qa', busy: false }],
      log: (line) => lines.push(line),
    });

    expect(result.retired).toEqual([]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.why).toContain('no OpenADLC label or mark');
    expect(calls.some((args) => args[0] === 'rm' || args[0] === 'network')).toBe(false);
    expect(lines.join('\n')).toContain('docker rm -f -v bot-qa bot-qa-db');
  });

  it('takes an unlabelled container as the default install’s by OpenADLC’s image or its seat network', async () => {
    const { calls, docker } = daemon({
      'bot-sre': { image: 'fleetadlc-bot:latest' },
      'bot-sre-db': { image: 'pgvector/pgvector:pg16', networks: ['fleet-bot-sre'] },
    });

    const result = await retireSeatContainers({
      docker,
      install: 'default',
      botPrefix: 'bot-',
      networkPrefix: 'fleetadlc-bot',
      seats: [{ name: 'sre', busy: false }],
    });

    expect(result).toEqual({ retired: ['sre'], kept: [] });
    expect(calls.filter((args) => args[0] === 'rm').map((args) => args.at(-1))).toEqual(['bot-sre', 'bot-sre-db']);
  });

  it('keeps an unlabelled container on an install that is not the default', async () => {
    const { calls, docker } = daemon({ 'acme-builder': { 'fleet.login': 'none' } });

    const result = await retireSeatContainers({
      docker,
      install: 'acme',
      botPrefix: 'acme-',
      networkPrefix: 'acme-net',
      seats: [{ name: 'builder', busy: false }],
    });

    expect(result.kept).toEqual([{ seat: 'builder', why: 'it belongs to install default' }]);
    expect(calls.some((args) => args[0] === 'rm' || args[0] === 'network')).toBe(false);
  });
});
