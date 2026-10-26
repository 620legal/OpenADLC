import { execFile as execFileCallback } from 'node:child_process';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { EGRESS_NAMES_PER_ASK, egressHostProblem, MAX_EGRESS_HOSTS, withoutCoveredHosts, type EgressAnswer, type EgressReport } from '@openadlc/shared';

/** How long the proxy may take to answer a CONNECT before the name is not known either way. */
export const EGRESS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Letters, digits, hyphens and dots, which is all that goes on the CONNECT
 * line: a name with a space or a line break in it would write a request of
 * its own to the proxy. An IPv4 address passes, and the proxy refuses it
 * whatever the list says, which is its answer to give.
 */
const NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The proxy to ask, as hostd reaches it; null where tasks leave through none.
 *
 * `OPENADLC_BOT_EGRESS_PROXY` is what says a task's traffic goes through one,
 * but it names it as a container does, at `host.docker.internal`, which hostd
 * on the cloud host's own network cannot resolve. hostd's own proxy variable
 * names the same proxy from where it runs, and the proxy holds one list for
 * every caller on the host (docs/security.md, Egress).
 */
export function egressProxyToAsk(env: NodeJS.ProcessEnv = process.env): string | null {
  const tasks = env.OPENADLC_BOT_EGRESS_PROXY?.trim();
  if (!tasks) return null;
  return env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || tasks;
}

/**
 * Whether a task's request to a name gets past the egress allowlist, asked of
 * the proxy itself.
 *
 * A cloud host's tasks leave only through the proxy, which refuses a name off
 * its list. On the first cloud install every request a QA task made to its
 * repository's testing URL was cancelled there; the task reported "not run",
 * and nothing told anyone the host had to be listed. So the bridge asks here,
 * for each repository's testing host, and says so on the board.
 *
 * Asked as a task's HTTPS request is: a `CONNECT <name>:443`, which the proxy
 * answers 403 for a name it refuses and 200 once it has opened the tunnel.
 * The tunnel is closed at once with nothing sent through it, so the testing
 * environment sees a connection and no request. A 5xx is the proxy letting
 * the name through and not reaching it, which is the environment's doing,
 * not the allowlist's. Each refusal is a `TCP_DENIED` line in the proxy's log
 * like a task's, and counts toward the egress denial alert.
 */
export class EgressProbe {
  constructor(
    private readonly proxy: string | null,
    private readonly timeoutMs = EGRESS_PROBE_TIMEOUT_MS,
  ) {}

  /** One answer for every name asked; more than `EGRESS_NAMES_PER_ASK` is refused whole rather than any dropped. */
  async ask(hosts: readonly string[]): Promise<Omit<EgressReport, 'settingsList'>> {
    const names = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
    if (names.length > EGRESS_NAMES_PER_ASK) {
      throw new EgressListRefused(`ask about at most ${EGRESS_NAMES_PER_ASK} names at once, not ${names.length}: ask again in batches`, 400);
    }
    if (!this.proxy) return { proxied: false, hosts: [] };
    return { proxied: true, hosts: await Promise.all(names.map((host) => this.one(this.proxy!, host))) };
  }

  private one(proxy: string, host: string): Promise<EgressAnswer> {
    if (!NAME.test(host)) return Promise.resolve({ host, allowed: null, reason: `${host} is not a host name the proxy can be asked about` });
    let target: URL;
    try {
      target = new URL(proxy);
    } catch {
      return Promise.resolve({ host, allowed: null, reason: `the egress proxy's address (${proxy}) is not a URL` });
    }
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);

    return new Promise((resolve) => {
      let settled = false;
      let answer = '';
      const socket = connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port });
      const finish = (result: EgressAnswer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ host, allowed: null, reason: `the egress proxy did not answer within ${Math.round(this.timeoutMs / 1000)}s` }),
        this.timeoutMs,
      );
      timer.unref?.();
      socket.setEncoding('latin1');
      socket.once('connect', () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
      socket.on('data', (chunk: string) => {
        answer += chunk;
        const end = answer.indexOf('\r\n');
        if (end === -1 && answer.length < 1024) return;
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer.slice(0, end === -1 ? undefined : end))?.[1] ?? NaN);
        if (status === 403) finish({ host, allowed: false, status });
        else if ((status >= 200 && status < 300) || (status >= 500 && status < 600)) finish({ host, allowed: true });
        else finish({ host, allowed: null, reason: Number.isNaN(status) ? 'the egress proxy did not answer in HTTP' : `the egress proxy answered ${status}` });
      });
      socket.on('error', (error) => finish({ host, allowed: null, reason: `the egress proxy could not be reached: ${error.message}` }));
      socket.on('close', () => finish({ host, allowed: null, reason: 'the egress proxy closed the connection without answering' }));
    });
  }
}

/** A list hostd will not write, a proxy that did not take it, or an ask it will not make: said to whoever asked. */
export class EgressListRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const execFile = promisify(execFileCallback);

/**
 * The names an admin allowed in Settings, put on the cloud host's proxy.
 *
 * Widening egress was `extra_allowed_domains` and `openadlc cloud apply`,
 * whose new cloud-init resets the host and ends every task on it. The proxy
 * now also reads a file of names (`acl allowed_extra dstdomain -n "<file>"`
 * in the host's squid.conf), which this writes, each with the leading dot the
 * module's own names get, and then has Squid read its configuration again:
 * the tasks running keep running. The file is in a directory both hostd and
 * the proxy's container mount, and is replaced whole by a rename, so the
 * proxy never reads half of one.
 *
 * Only the names a person saved come here, from the bridge's Settings route
 * or the stored list at start; nothing a repository's files say does. Each is
 * checked again here, since what is written is read by the only way out of
 * the host. Unset (`file` or `container` null) where there is no such proxy:
 * a laptop, or a cloud host whose cloud-init is from before the file.
 */
export class EgressList {
  /** Counts every apply begun, so the list read at start can tell a save began after it. */
  private begun = 0;
  /** Each write waits for the one before it: two at once could rename the older over the newer. */
  private writing: Promise<unknown> = Promise.resolve();
  private temporary = 0;

  constructor(
    private readonly options: {
      file: string | null;
      container: string | null;
      /** Runs `docker` with these arguments; the real one unless a test gives another. */
      docker?: (args: string[]) => Promise<void>;
      now?: () => Date;
    },
  ) {}

  /** Whether this host's proxy reads the list. */
  get available(): boolean {
    return Boolean(this.options.file && this.options.container);
  }

  /** Writes the names and has the proxy read them; what it wrote. */
  apply(hosts: readonly string[]): Promise<string[]> {
    this.begun += 1;
    return this.inTurn(() => this.write(hosts));
  }

  /**
   * The list Settings holds, read and written at hostd's start; null when a
   * save began while it was read, which is newer, and is left as it is.
   *
   * The start's apply ran beside the server: a save the bridge sent while the
   * stored list was still being read was written first, and then the older
   * list was written over it, so the proxy refused a name Settings showed as
   * allowed until the next save.
   */
  async applyStored(read: () => Promise<readonly string[]>): Promise<string[] | null> {
    const mine = (this.begun += 1);
    const hosts = await read();
    return this.inTurn(() => (this.begun === mine ? this.write(hosts) : Promise.resolve(null)));
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.writing.then(work);
    this.writing = turn.catch(() => undefined);
    return turn;
  }

  private async write(hosts: readonly string[]): Promise<string[]> {
    const { file, container } = this.options;
    if (!file || !container) {
      throw new EgressListRefused(
        'this host’s egress proxy reads no list from Settings: a laptop has no proxy, and a cloud host gets one when the module is applied with this release',
        501,
      );
    }
    if (hosts.length > MAX_EGRESS_HOSTS) throw new EgressListRefused(`at most ${MAX_EGRESS_HOSTS} names may be allowed`, 400);
    for (const host of hosts) {
      const problem = egressHostProblem(host);
      if (problem) throw new EgressListRefused(problem, 400);
    }
    const names = withoutCoveredHosts(hosts);
    const at = (this.options.now ?? (() => new Date()))().toISOString();
    const text = [
      `# Written by hostd from Settings → Egress at ${at}; the audit trail says who saved it.`,
      '# Each name and everything under it. Change it in Settings, not here: hostd writes it again at every start.',
      ...names.map((name) => `.${name}`),
      '',
    ].join('\n');
    const next = join(dirname(file), `.${process.pid}-${(this.temporary += 1)}.next`);
    await writeFile(next, text);
    // Squid reads it as its own user, not hostd's uid, and writeFile's mode
    // is narrowed by hostd's umask: a file only hostd could read would leave
    // the proxy with no list at all.
    await chmod(next, 0o644);
    await rename(next, file);
    const docker = this.options.docker ?? (async (args: string[]) => void (await execFile('docker', args, { timeout: 30_000 })));
    try {
      await docker(['exec', container, 'squid', '-k', 'reconfigure']);
    } catch (error) {
      const said = (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
      throw new EgressListRefused(`the list was written, and the egress proxy did not read it again: ${said.slice(0, 300)}`, 502);
    }
    return names;
  }
}
