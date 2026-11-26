import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { discover, discoverTarget, proposalLines, type DiscoverProposalView, type DiscoverRunView } from './discover.js';
import type { Output } from './ls.js';

/**
 * `openadlc discover`, against a stand-in bridge: it starts a run, waits for
 * it, and prints what the bridge says, refusals in the bridge's own words.
 */

const RUN: DiscoverRunView = {
  id: '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10',
  repo: '620legal/OpenADLC',
  state: 'running',
  lenses: ['improve'],
  commit: null,
  proposalCount: 0,
  droppedCount: 0,
  note: null,
  reason: null,
};

const PROPOSAL: DiscoverProposalView = {
  lens: 'improve',
  key: 'finish-csv-export',
  title: 'Finish the CSV export',
  description: 'The handler returns an empty file.',
  status: 'partial',
  evidence: [{ file: 'apps/web/src/export.ts', line: 12 }],
};

function captured(): Output & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line) => void stdout.push(line), err: (line) => void stderr.push(line) };
}

const noHeaders = async (): Promise<Record<string, string>> => ({});

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

interface Seen {
  method: string;
  url: string;
  body: string;
}

/** A bridge that answers the start with `start`, and each read with the next of `reads`, the last one again once they run out. */
async function bridge(start: { status: number; body: unknown }, reads: { status: number; body: unknown }[]): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      seen.push({ method: request.method ?? '', url: request.url ?? '', body });
      const answer = request.method === 'POST' ? start : reads.length > 1 ? reads.shift()! : reads[0]!;
      response.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

const config = (port: number) => ({ ports: { bridge: port } as never });
const reach = { fetch, headers: noHeaders };

describe('openadlc discover', () => {
  it('starts a run, waits for it to end, and prints each proposal with its status, description and lines', async () => {
    const done = { ...RUN, state: 'done', commit: 'a'.repeat(40), proposalCount: 1, droppedCount: 2 };
    const { port, seen } = await bridge({ status: 202, body: { run: RUN } }, [
      { status: 200, body: { run: RUN, proposals: [] } },
      { status: 200, body: { run: done, proposals: [PROPOSAL] } },
    ]);
    const output = captured();

    expect(await discover(config(port), { repo: '620legal/OpenADLC', detach: false, json: false, pollMs: 5 }, output, reach)).toBe(0);

    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/repos/620legal%2FOpenADLC/discover', body: '{}' });
    expect(seen.filter((one) => one.method === 'GET').map((one) => one.url)).toEqual([
      `/v1/repos/620legal%2FOpenADLC/discover/runs/${RUN.id}`,
      `/v1/repos/620legal%2FOpenADLC/discover/runs/${RUN.id}`,
    ]);
    expect(output.stdout).toContain('620legal/OpenADLC at aaaaaaa: 1 proposal, 2 dropped for want of evidence or form');
    expect(output.stdout).toEqual(expect.arrayContaining(['[partial] Finish the CSV export', '  The handler returns an empty file.', '  apps/web/src/export.ts:12']));
    expect(output.stderr).toEqual([]);
  });

  it('sends the lenses it was given, and prints the bridge’s refusal of one that does not exist', async () => {
    const { port, seen } = await bridge({ status: 400, body: { error: 'there is no lens nope; the lenses are: improve' } }, [{ status: 500, body: {} }]);
    const output = captured();

    expect(await discover(config(port), { repo: '620legal/OpenADLC', lens: 'nope', detach: false, json: false }, output, reach)).toBe(1);

    expect(JSON.parse(seen[0]!.body)).toEqual({ lenses: ['nope'] });
    expect(output.stderr).toEqual(['there is no lens nope; the lenses are: improve']);
  });

  it('prints the bridge’s words for a repository it does not manage, and exits 1', async () => {
    const words = 'someone/else is not a repository this install manages; add it in Settings → Repositories first';
    const { port } = await bridge({ status: 404, body: { error: words } }, [{ status: 500, body: {} }]);
    const output = captured();
    expect(await discover(config(port), { repo: 'someone/else', detach: false, json: false }, output, reach)).toBe(1);
    expect(output.stderr).toEqual([words]);
  });

  it('says there is nothing to propose, with the run’s note, and exits 0', async () => {
    const empty = { ...RUN, state: 'done', note: 'the default branch has no commits' };
    const { port } = await bridge({ status: 202, body: { run: empty } }, [{ status: 200, body: { run: empty, proposals: [] } }]);
    const output = captured();
    expect(await discover(config(port), { repo: '620legal/OpenADLC', detach: false, json: false }, output, reach)).toBe(0);
    expect(output.stdout).toEqual(['No proposals: the default branch has no commits']);
  });

  it('exits 1 on a failed run, with its reason', async () => {
    const failed = { ...RUN, state: 'failed', reason: 'the Discover run ended without its proposals' };
    const { port } = await bridge({ status: 202, body: { run: RUN } }, [{ status: 200, body: { run: failed, proposals: [] } }]);
    const output = captured();
    expect(await discover(config(port), { repo: '620legal/OpenADLC', detach: false, json: false, pollMs: 5 }, output, reach)).toBe(1);
    expect(output.stderr).toEqual(['the Discover run on 620legal/OpenADLC failed: the Discover run ended without its proposals']);
  });

  it('with --detach, starts the run and says how to follow it, without waiting', async () => {
    const { port, seen } = await bridge({ status: 202, body: { run: RUN } }, [{ status: 500, body: {} }]);
    const output = captured();
    expect(await discover(config(port), { repo: '620legal/OpenADLC', detach: true, json: false }, output, reach)).toBe(0);
    expect(seen.map((one) => one.method)).toEqual(['POST']);
    expect(output.stdout).toEqual([`Started Discover run ${RUN.id} on 620legal/OpenADLC.`, `Follow it: openadlc discover 620legal/OpenADLC --run ${RUN.id}`]);
  });

  it('with --run, follows a run already started and starts none', async () => {
    const done = { ...RUN, state: 'done', commit: 'b'.repeat(40) };
    const { port, seen } = await bridge({ status: 500, body: {} }, [{ status: 200, body: { run: done, proposals: [PROPOSAL] } }]);
    const output = captured();
    expect(await discover(config(port), { repo: '620legal/OpenADLC', run: RUN.id, detach: false, json: true }, output, reach)).toBe(0);
    expect(seen.map((one) => one.method)).toEqual(['GET']);
    expect(JSON.parse(output.stdout[0]!)).toEqual({ run: done, proposals: [PROPOSAL] });
  });

  it('on Ctrl-C, stops waiting and leaves the run going, saying how to see it', async () => {
    const { port } = await bridge({ status: 202, body: { run: RUN } }, [{ status: 200, body: { run: RUN, proposals: [] } }]);
    const output = captured();
    const stop = new AbortController();
    const waiting = discover(config(port), { repo: '620legal/OpenADLC', detach: false, json: false, signal: stop.signal, pollMs: 60_000 }, output, reach);
    setTimeout(() => stop.abort(), 50);
    expect(await waiting).toBe(0);
    expect(output.stderr).toEqual([`stopped waiting; the run goes on. See it with: openadlc discover 620legal/OpenADLC --run ${RUN.id}`]);
  });

  it('says to start the bridge when it does not answer', async () => {
    const output = captured();
    const unreachable = { fetch: (async () => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch, headers: noHeaders };
    expect(await discover(config(1), { repo: '620legal/OpenADLC', detach: false, json: false }, output, unreachable)).toBe(1);
    expect(output.stderr).toEqual(['the bridge is not answering on 127.0.0.1:1. Run: openadlc up']);
  });

  it('asks for the repository when none is named', async () => {
    const output = captured();
    expect(await discover(config(1), { repo: undefined, detach: false, json: false }, output, reach)).toBe(2);
    expect(output.stderr[0]).toContain('name the repository');
  });
});

describe('reading the command line', () => {
  it('takes the repository from whichever argument is not a flag or a flag’s value', () => {
    expect(discoverTarget(['620legal/OpenADLC', '--json'])).toBe('620legal/OpenADLC');
    expect(discoverTarget(['--lens', 'improve', '620legal/OpenADLC'])).toBe('620legal/OpenADLC');
    expect(discoverTarget(['--run', 'abc', 'OpenADLC'])).toBe('OpenADLC');
    expect(discoverTarget(['--lens=improve', 'OpenADLC'])).toBe('OpenADLC');
    expect(discoverTarget(['--json'])).toBeUndefined();
  });

  it('prints a proposal as its status and title, its description, then its lines', () => {
    expect(proposalLines(PROPOSAL)).toEqual(['[partial] Finish the CSV export', '  The handler returns an empty file.', '  apps/web/src/export.ts:12']);
  });
});
