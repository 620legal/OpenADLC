import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EGRESS_NAMES_PER_ASK } from '@openadlc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { EgressList, EgressListRefused, EgressProbe, egressProxyToAsk } from './egress.js';

/**
 * A cloud host's tasks leave only through the proxy's allowlist, and on the
 * first cloud install every request a QA task made to its testing URL was
 * refused there with nothing to say so. The probe asks the proxy what it
 * would do with a task's CONNECT; this proxy answers as the cloud host's
 * Squid does.
 */

let proxy: Server | null = null;
const asked: string[] = [];
/** The proxy's side of each connection, ended after each test: a tunnel it opened is held open, as Squid's is. */
const accepted = new Set<Socket>();

function listening(handle: (socket: Socket) => void): Server {
  return createServer((socket) => {
    accepted.add(socket);
    socket.on('close', () => accepted.delete(socket));
    handle(socket);
  });
}

/** A proxy that lets these names through, refuses every other, and answers 503 for one it cannot reach. */
async function squid(allowed: string[], unreachable: string[] = []): Promise<string> {
  asked.length = 0;
  proxy = listening((socket) => {
    socket.setEncoding('latin1');
    let request = '';
    socket.on('data', (chunk: string) => {
      request += chunk;
      if (!request.includes('\r\n\r\n')) return;
      const line = request.split('\r\n')[0] ?? '';
      asked.push(line);
      const host = /^CONNECT ([^:]+):443 /.exec(line)?.[1] ?? '';
      if (unreachable.includes(host)) socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      else if (allowed.some((name) => host === name || host.endsWith(`.${name}`))) socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      else socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\n\r\n<html>ERR_ACCESS_DENIED</html>');
    });
  });
  await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const socket of accepted) socket.destroy();
  const closing = proxy;
  proxy = null;
  await new Promise<void>((resolve) => (closing ? closing.close(() => resolve()) : resolve()));
});

describe('asking the egress proxy about a name', () => {
  it('reads a 403 to the CONNECT as the allowlist refusing it, and a tunnel as letting it through', async () => {
    const probe = new EgressProbe(await squid(['github.com', 'testing.acme.example']));
    expect(await probe.ask(['web-1234-uc.a.run.app', 'testing.acme.example', 'api.github.com'])).toEqual({
      proxied: true,
      hosts: [
        { host: 'web-1234-uc.a.run.app', allowed: false, status: 403 },
        { host: 'testing.acme.example', allowed: true },
        { host: 'api.github.com', allowed: true },
      ],
    });
    expect(asked).toContain('CONNECT web-1234-uc.a.run.app:443 HTTP/1.1');
  });

  it('counts a name the proxy let through and could not reach as allowed: the environment is down, not refused', async () => {
    const probe = new EgressProbe(await squid([], ['testing.acme.example']));
    expect((await probe.ask(['testing.acme.example'])).hosts).toEqual([{ host: 'testing.acme.example', allowed: true }]);
  });

  it('answers every name it is asked, and refuses more than it asks at once rather than dropping any', async () => {
    // It kept the first 20 and dropped the rest without a word, and a testing
    // host dropped that way raised no card.
    const probe = new EgressProbe(await squid(['acme.example']));
    const names = Array.from({ length: EGRESS_NAMES_PER_ASK + 1 }, (_, index) => `web${index}.acme.example`);
    expect((await probe.ask(names.slice(0, EGRESS_NAMES_PER_ASK))).hosts).toHaveLength(EGRESS_NAMES_PER_ASK);
    asked.length = 0;
    await expect(probe.ask(names)).rejects.toMatchObject({ status: 400, message: expect.stringContaining(`at most ${EGRESS_NAMES_PER_ASK} names`) });
    expect(asked).toEqual([]);
  });

  it('asks nothing on a host whose tasks leave through no proxy, which refuses nothing', async () => {
    expect(await new EgressProbe(null).ask(['testing.acme.example'])).toEqual({ proxied: false, hosts: [] });
  });

  it('never writes a name that is not one onto the CONNECT line', async () => {
    const probe = new EgressProbe(await squid(['acme.example']));
    const { hosts } = await probe.ask(['acme.example:443 HTTP/1.1\r\nHost: evil.example\r\n\r\nGET http://evil.example/']);
    expect(hosts[0]).toMatchObject({ allowed: null, reason: expect.stringContaining('is not a host name') });
    expect(asked).toEqual([]);
  });

  it('gives no answer when the proxy cannot be reached or says nothing in time', async () => {
    const address = await squid([]);
    await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    proxy = null;
    const [refused] = (await new EgressProbe(address).ask(['acme.example'])).hosts;
    expect(refused).toMatchObject({ allowed: null, reason: expect.stringContaining('could not be reached') });

    proxy = listening(() => undefined);
    await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
    const silent = new EgressProbe(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, 50);
    expect((await silent.ask(['acme.example'])).hosts[0]).toMatchObject({ allowed: null, reason: expect.stringContaining('did not answer') });
  });
});

describe('which proxy hostd asks', () => {
  it('is hostd’s own, the same proxy the tasks’ address names from inside a container, only where tasks have one', () => {
    expect(egressProxyToAsk({ OPENADLC_BOT_EGRESS_PROXY: 'http://host.docker.internal:3128', HTTPS_PROXY: 'http://127.0.0.1:3128' })).toBe('http://127.0.0.1:3128');
    expect(egressProxyToAsk({ OPENADLC_BOT_EGRESS_PROXY: 'http://proxy.internal:3128' })).toBe('http://proxy.internal:3128');
    expect(egressProxyToAsk({ HTTPS_PROXY: 'http://corporate.example:8080' })).toBeNull();
    expect(egressProxyToAsk({})).toBeNull();
  });
});

describe('the names an admin allowed, put on the proxy', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function list(docker: (args: string[]) => Promise<void> = async () => undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'openadlc-egress-'));
    dirs.push(dir);
    const file = join(dir, 'extra-domains');
    writeFileSync(file, '# empty\n');
    const ran: string[][] = [];
    const subject = new EgressList({
      file,
      container: 'openadlc-egress',
      docker: async (args) => {
        ran.push(args);
        await docker(args);
      },
      now: () => new Date('2026-10-26T09:00:00.000Z'),
    });
    return { subject, file, dir, ran };
  }

  it('writes each name with the leading dot the module’s own get, then has Squid read its configuration again', async () => {
    const { subject, file, dir, ran } = list();
    expect(await subject.apply(['web-1234-uc.a.run.app', 'testing.acme.example', 'acme.example'])).toEqual(['web-1234-uc.a.run.app', 'acme.example']);
    const written = readFileSync(file, 'utf8').split('\n').filter((line) => line && !line.startsWith('#'));
    expect(written).toEqual(['.web-1234-uc.a.run.app', '.acme.example']);
    expect(ran).toEqual([['exec', 'openadlc-egress', 'squid', '-k', 'reconfigure']]);
    // Replaced whole, so the proxy never read half a list: nothing is left beside it.
    expect(readdirSync(dir)).toEqual(['extra-domains']);
  });

  it('leaves the file readable by the proxy, which reads it as its own user, whatever hostd’s umask', async () => {
    const { subject, file } = list();
    const before = process.umask(0o077);
    try {
      await subject.apply(['acme.example']);
    } finally {
      process.umask(before);
    }
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it('writes the list Settings holds at start, unless a save began while it was read, which is newer', async () => {
    const names = (file: string) => readFileSync(file, 'utf8').split('\n').filter((line) => line && !line.startsWith('#'));
    const quiet = list();
    expect(await quiet.subject.applyStored(async () => ['acme.example'])).toEqual(['acme.example']);
    expect(names(quiet.file)).toEqual(['.acme.example']);

    // The start's read of Settings is slow; the bridge's save lands meanwhile.
    const { subject, file, ran } = list();
    let read!: (hosts: string[]) => void;
    const atStart = subject.applyStored(() => new Promise<string[]>((resolve) => (read = resolve)));
    expect(await subject.apply(['testing.acme.example'])).toEqual(['testing.acme.example']);
    read(['old.acme.example']);
    expect(await atStart).toBeNull();
    expect(names(file)).toEqual(['.testing.acme.example']);
    expect(ran).toHaveLength(1);
  });

  it('writes two saves made at once one after the other, the later last', async () => {
    const { subject, file, dir } = list();
    const [first, second] = await Promise.allSettled([subject.apply(['one.acme.example']), subject.apply(['two.acme.example'])]);
    expect([first.status, second.status]).toEqual(['fulfilled', 'fulfilled']);
    expect(readFileSync(file, 'utf8')).toContain('\n.two.acme.example\n');
    expect(readdirSync(dir)).toEqual(['extra-domains']);
  });

  it('writes an empty list when the last name is removed, which lets nothing more through', async () => {
    const { subject, file } = list();
    await subject.apply(['acme.example']);
    await subject.apply([]);
    expect(readFileSync(file, 'utf8').split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([]);
  });

  it('writes nothing it would not let a person save, and nothing at all when one name is wrong', async () => {
    const { subject, file, ran } = list();
    await expect(subject.apply(['acme.example', 'acme.example\nhttp_access allow all'])).rejects.toMatchObject({ status: 400 });
    await expect(subject.apply(['10.0.0.5'])).rejects.toBeInstanceOf(EgressListRefused);
    expect(readFileSync(file, 'utf8')).toBe('# empty\n');
    expect(ran).toEqual([]);
  });

  it('says so when the proxy did not read it again', async () => {
    const { subject } = list(async () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'Error: No such container: openadlc-egress' });
    });
    await expect(subject.apply(['acme.example'])).rejects.toMatchObject({ status: 502, message: expect.stringContaining('No such container') });
  });

  it('refuses where the host’s proxy reads no such file: a laptop, or a cloud-init from before it', async () => {
    const laptop = new EgressList({ file: null, container: null });
    expect(laptop.available).toBe(false);
    await expect(laptop.apply(['acme.example'])).rejects.toMatchObject({ status: 501 });
  });
});

describe('the list and the proxy together', () => {
  it('lets a task through to a name once an admin allows it or a name above it, and probing changes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openadlc-egress-'));
    try {
      const file = join(dir, 'extra-domains');
      writeFileSync(file, '');
      // Squid's dstdomain: `.name` is the name and everything under it, a bare name only itself.
      const fromFile = () =>
        readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line && !line.startsWith('#'));
      const address = await (async () => {
        asked.length = 0;
        proxy = listening((socket) => {
          socket.setEncoding('latin1');
          socket.once('data', (chunk: string) => {
            const host = /^CONNECT ([^:]+):443 /.exec(chunk)?.[1] ?? '';
            const allowed = fromFile().some((entry) => (entry.startsWith('.') ? host === entry.slice(1) || host.endsWith(entry) : host === entry));
            socket.write(allowed ? 'HTTP/1.1 200 Connection established\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\n\r\n');
          });
        });
        await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
        return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      })();
      const probe = new EgressProbe(address);
      const list = new EgressList({ file, container: 'openadlc-egress', docker: async () => undefined });

      expect((await probe.ask(['web-1234-uc.a.run.app'])).hosts[0]).toMatchObject({ allowed: false });
      expect(fromFile()).toEqual([]);

      await list.apply(['a.run.app']);
      expect((await probe.ask(['web-1234-uc.a.run.app'])).hosts[0]).toEqual({ host: 'web-1234-uc.a.run.app', allowed: true });

      await list.apply(['web-1234-uc.a.run.app']);
      expect((await probe.ask(['web-1234-uc.a.run.app', 'other-uc.a.run.app'])).hosts.map((one) => one.allowed)).toEqual([true, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
