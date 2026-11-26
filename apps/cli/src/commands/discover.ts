import { answerOf } from '../attach.js';
import type { InstallConfig } from '../install.js';
import { liveBridge, terminal, type BridgeReach, type Output } from './ls.js';

/**
 * `openadlc discover OWNER/NAME`: starts a Discover run on a managed
 * repository through the bridge (`POST /v1/repos/:name/discover`), waits for
 * it, and prints what it proposes (#370, docs/adr/0089). It never opens the
 * database, and the run writes nothing to GitHub.
 *
 * `--run ID` follows a run already started instead, and `--detach` starts one
 * and leaves it. Ctrl-C stops the waiting, not the run.
 */

/** A run as the bridge answers it (`apps/bridge/src/discover.ts`). */
export interface DiscoverRunView {
  id: string;
  repo: string;
  state: 'running' | 'done' | 'failed';
  lenses: string[];
  commit: string | null;
  proposalCount: number;
  droppedCount: number;
  note: string | null;
  reason: string | null;
}

export interface DiscoverProposalView {
  lens: string;
  key: string;
  title: string;
  description: string;
  status: string;
  evidence: { file: string; line: number }[];
}

export interface DiscoverOptions {
  /** The repository, `owner/name` or its name. */
  repo: string | undefined;
  /** `--lens`, comma-separated; every lens when not given. */
  lens?: string | undefined;
  /** `--run`: a run already started, to follow. */
  run?: string | undefined;
  detach: boolean;
  json: boolean;
  /** Ctrl-C: stop waiting, and leave the run going. */
  signal?: AbortSignal;
  /** How long between looks at a running run. */
  pollMs?: number;
}

/** The repository a command line names: its first argument that is neither a flag nor a flag's value. */
export function discoverTarget(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument.startsWith('-')) {
      // `--lens improve` and `--run ID` take the next argument; `--lens=improve` does not.
      if ((argument === '--lens' || argument === '--run') && !(args[index + 1] ?? '-').startsWith('-')) index += 1;
      continue;
    }
    return argument;
  }
  return undefined;
}

/** A proposal as a person reads it: its status and title, its description, and the lines that show it. */
export function proposalLines(proposal: DiscoverProposalView): string[] {
  return [`[${proposal.status}] ${proposal.title}`, `  ${proposal.description}`, ...proposal.evidence.map((one) => `  ${one.file}:${one.line}`)];
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Starts or follows a run, and prints it. Answers the exit code. */
export async function discover(
  config: Pick<InstallConfig, 'ports'>,
  options: DiscoverOptions,
  output: Output = terminal,
  bridge: BridgeReach = liveBridge,
): Promise<number> {
  const where = `127.0.0.1:${config.ports.bridge}`;
  if (!options.repo) {
    output.err('name the repository: openadlc discover OWNER/NAME [--lens LIST] [--detach] [--json], or OWNER/NAME --run ID');
    return 2;
  }
  const repo = options.repo;
  const base = `http://${where}/v1/repos/${encodeURIComponent(repo)}/discover`;
  const follow = (id: string) => `openadlc discover ${repo} --run ${id}`;

  /** One call to the bridge; null when it did not answer, which has been said. */
  const call = async (url: string, init: RequestInit = {}): Promise<Response | null> => {
    try {
      return await bridge.fetch(url, {
        ...init,
        headers: { ...(await bridge.headers()), ...(init.body ? { 'content-type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      output.err(`the bridge is not answering on ${where}. Run: openadlc up`);
      return null;
    }
  };
  const refused = async (response: Response, what: string): Promise<number> => {
    const answer = await answerOf(response);
    output.err(answer.error ?? `the bridge refused ${what} (${answer.status})`);
    return 1;
  };

  let run: DiscoverRunView;
  if (options.run) {
    run = { id: options.run } as DiscoverRunView;
  } else {
    const lenses = options.lens
      ?.split(',')
      .map((lens) => lens.trim())
      .filter(Boolean);
    const started = await call(base, { method: 'POST', body: JSON.stringify(options.lens !== undefined ? { lenses: lenses ?? [] } : {}) });
    if (!started) return 1;
    if (!started.ok) return refused(started, 'the run');
    run = ((await started.json()) as { run: DiscoverRunView }).run;
    if (options.detach) {
      if (options.json) output.out(JSON.stringify(run));
      else {
        output.out(`Started Discover run ${run.id} on ${run.repo}.`);
        output.out(`Follow it: ${follow(run.id)}`);
      }
      return 0;
    }
    if (!options.json && run.state === 'running') output.out(`Discover run ${run.id} started on ${run.repo}; waiting for it (Ctrl-C leaves it running).`);
  }

  // Looked at until it ends; a start that ended at once (an empty repository) is read once.
  let proposals: DiscoverProposalView[] = [];
  for (;;) {
    const read = await call(`${base}/runs/${encodeURIComponent(run.id)}`);
    if (!read) return 1;
    if (!read.ok) return refused(read, 'the run');
    const view = (await read.json()) as { run: DiscoverRunView; proposals: DiscoverProposalView[] };
    run = view.run;
    proposals = view.proposals;
    if (run.state !== 'running') break;
    await sleep(options.pollMs ?? 5_000, options.signal);
    if (options.signal?.aborted) {
      output.err(`stopped waiting; the run goes on. See it with: ${follow(run.id)}`);
      return 0;
    }
  }

  if (options.json) {
    output.out(JSON.stringify({ run, proposals }));
    return run.state === 'failed' ? 1 : 0;
  }
  if (run.state === 'failed') {
    output.err(`the Discover run on ${run.repo} failed: ${run.reason ?? 'no reason was recorded'}`);
    return 1;
  }
  if (proposals.length === 0) {
    output.out(`No proposals: ${run.note ?? 'the run found nothing worth proposing'}`);
    return 0;
  }
  const at = run.commit ? ` at ${run.commit.slice(0, 7)}` : '';
  const dropped = run.droppedCount > 0 ? `, ${run.droppedCount} dropped for want of evidence or form` : '';
  output.out(`${run.repo}${at}: ${proposals.length} proposal${proposals.length === 1 ? '' : 's'}${dropped}`);
  for (const proposal of proposals) {
    output.out('');
    for (const line of proposalLines(proposal)) output.out(line);
  }
  if (run.note) {
    output.out('');
    output.out(`Note: ${run.note}`);
  }
  return 0;
}
