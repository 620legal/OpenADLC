import type { DockerResult } from './drivers/docker.js';

/** What `retireSeatContainers` needs: how this install named its seats' containers and networks, and its seats. */
export interface RetireInput {
  docker: (args: string[]) => Promise<DockerResult>;
  /** This install's id (`fleetadlc.install`); the default install's is `default`. */
  install: string;
  /** What seat containers were named after: `bot-`, or `FLEETADLC_BOT_PREFIX`. */
  botPrefix: string;
  /** What seat networks were named after: `fleetadlc-bot`, or the prefix's `net`. */
  networkPrefix: string;
  seats: readonly { name: string; busy: boolean }[];
  log?: (line: string) => void;
}

export interface Retired {
  retired: string[];
  kept: { seat: string; why: string }[];
}

/**
 * What `ownerOf` answers for an unlabelled container with none of OpenADLC's
 * marks. The NUL cannot be in an install id, so it never matches one, and the
 * `foreign` check keeps the container.
 */
const UNMARKED = '\0unmarked';

interface Inspected {
  Config?: { Labels?: Record<string, string> | null; Image?: string };
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

/**
 * Whether an unlabelled container is one OpenADLC made before installs were
 * labelled. Seat names are ordinary words, so an operator's own `bot-qa` can
 * share the name; removing it on the name alone deleted their container and
 * its data at every start. A seat ran OpenADLC's image with a `login` label
 * (and an `image` label when one was given); its sidecar had no labels, but
 * sat on the seat's own network.
 */
function fingerprinted(entry: Inspected, sidecar: boolean, seat: string, networkPrefix: string): boolean {
  if (sidecar) {
    const networks = Object.keys(entry.NetworkSettings?.Networks ?? {});
    return networks.includes(`${networkPrefix}-${seat}`) || networks.includes(`fleet-bot-${seat}`);
  }
  const labels = entry.Config?.Labels ?? {};
  if (['fleet.login', 'fleetadlc.login', 'fleet.image', 'fleetadlc.image'].some((key) => key in labels)) return true;
  return entry.Config?.Image === 'fleet-bot:latest' || entry.Config?.Image === 'fleetadlc-bot:latest';
}

/**
 * Whose a container is: its install label; the default install for one made
 * before labels that carries OpenADLC's marks; `UNMARKED` for one with
 * neither; null when there is none.
 */
async function ownerOf(input: RetireInput, name: string, seat: string, sidecar: boolean): Promise<string | null> {
  const found = await input.docker(['container', 'inspect', name]);
  if (found.code !== 0) return null;
  try {
    const [entry] = JSON.parse(found.stdout) as Inspected[];
    const label = entry?.Config?.Labels?.['fleetadlc.install'];
    if (label) return label;
    return entry && fingerprinted(entry, sidecar, seat, input.networkPrefix) ? 'default' : UNMARKED;
  } catch {
    return 'unreadable';
  }
}

/**
 * Takes down what a seat had when each bot had one long-lived container: its
 * container `bot-<name>`, its database sidecar `bot-<name>-db`, and the network
 * the two shared (`fleetadlc-bot-<name>`, or `fleet-bot-<name>` from before
 * the rename). A task's computer is its own container now, so these do
 * nothing but hold memory, and a seat renamed later would leave them behind
 * under a name nothing looks for.
 *
 * Only what this install made goes — its label, or, on the default install,
 * no label but the marks OpenADLC's seats from before labels carry (see
 * `fingerprinted`) — and only for a seat with no task running: a task started
 * on the old model is still in its seat's container, and removing it would end
 * that task's session. Such a seat is retired at a later start. Its folder —
 * `homes/`, `repos/` — is left for a release, since a paused task's commits may
 * still be in its mirror; `fleetadlc doctor` says when it can go.
 */
export async function retireSeatContainers(input: RetireInput): Promise<Retired> {
  const result: Retired = { retired: [], kept: [] };
  for (const seat of input.seats) {
    const names = [`${input.botPrefix}${seat.name}`, `${input.botPrefix}${seat.name}-db`];
    const owners = await Promise.all(names.map((name, index) => ownerOf(input, name, seat.name, index === 1)));
    if (owners.every((owner) => owner === null)) continue;
    if (seat.busy) {
      result.kept.push({ seat: seat.name, why: 'it has a task running in it' });
      continue;
    }
    const foreign = owners.find((owner) => owner !== null && owner !== input.install);
    if (foreign === UNMARKED) {
      const unmarked = names.filter((_, index) => owners[index] === UNMARKED).join(' ');
      result.kept.push({
        seat: seat.name,
        why: `it has no OpenADLC label or mark, so it may be someone else's; if it is OpenADLC's, remove it with: docker rm -f -v ${unmarked}`,
      });
      continue;
    }
    if (foreign) {
      result.kept.push({ seat: seat.name, why: `it belongs to install ${foreign}` });
      continue;
    }
    for (const [index, name] of names.entries()) {
      if (owners[index] === null) continue;
      // `-v`: the image declares /work a volume, and a container removed
      // without it leaves that volume behind for good.
      const removed = await input.docker(['rm', '-f', '-v', name]);
      if (removed.code !== 0) input.log?.(`[hostd] could not remove ${name}: ${removed.stderr.trim().slice(0, 200)}`);
    }
    // A network something is still attached to is refused by Docker, which is
    // what should happen; one already gone is not a failure.
    await input.docker(['network', 'rm', `${input.networkPrefix}-${seat.name}`]);
    if (input.install === 'default') await input.docker(['network', 'rm', `fleet-bot-${seat.name}`]);
    result.retired.push(seat.name);
  }
  for (const seat of result.retired) input.log?.(`[hostd] retired ${input.botPrefix}${seat}: a task's computer is its own container now`);
  for (const { seat, why } of result.kept) input.log?.(`[hostd] left ${input.botPrefix}${seat} for now: ${why}`);
  return result;
}
