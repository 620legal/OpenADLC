import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `infra/local/install.sh` is what the README's one command runs on somebody's
 * own machine, with sudo. What it decides to install is checked here with
 * `--dry-run`, on a PATH of stand-ins: the machine's kind (`uname`), which
 * tools are there, and whether Docker answers. Nothing is installed, cloned or
 * built, and the answer does not depend on what the machine running the suite has.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'infra', 'local', 'install.sh');

/** What the script itself runs to decide, taken from the real machine. */
const UTILITIES = ['bash', 'sh', 'cat', 'sed', 'grep', 'head', 'dirname', 'seq', 'sleep', 'id', 'ls', 'mkdir', 'env', 'awk', 'tr'];

let work: string;
let bin: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'install-script-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  for (const tool of UTILITIES) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, join(bin, tool));
  }
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function stub(name: string, body = 'exit 0'): void {
  const path = join(bin, name);
  // Some names are links to the real tool (UTILITIES): writing through one
  // would overwrite the machine's own.
  rmSync(path, { force: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A machine of this kind, with these tools, where Docker answers or does not. */
function machine(kind: 'Darwin' | 'Linux', tools: { node?: number; docker?: 'answers' | 'silent' } & Record<string, unknown>): void {
  stub('uname', `echo ${kind}`);
  if (tools.node) stub('node', `echo ${tools.node}`);
  if (tools.docker) stub('docker', tools.docker === 'answers' ? 'exit 0' : 'exit 1');
  for (const name of Object.keys(tools)) {
    if (name !== 'node' && name !== 'docker') stub(name);
  }
}

function install(args: string[], options: { piped?: boolean; socket?: boolean } = {}): { status: number | null; out: string } {
  const env: Record<string, string> = { PATH: bin, HOME: work, TERM: 'dumb', USER: 'tester' };
  // A stand-in for the system daemon's socket.
  if (options.socket) env.OPENADLC_DOCKER_SOCKET = join(work, 'docker.sock');
  const run = options.piped
    ? spawnSync(join(bin, 'bash'), ['-s', '--', ...args], { env, input: readFileSync(SCRIPT, 'utf8'), encoding: 'utf8' })
    : spawnSync(join(bin, 'bash'), [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const EVERYTHING = { git: 1, node: 22, pnpm: 1, tmux: 1, cloudflared: 1, docker: 'answers' as const };

describe('the one-command install', () => {
  it('on a Mac that has everything, installs nothing and goes straight to the build', () => {
    machine('Darwin', { ...EVERYTHING, brew: 1 });
    const { status, out } = install(['--dry-run']);

    expect(status, out).toBe(0);
    expect(out).toContain('git, Node 22, pnpm, tmux, cloudflared and Docker are here');
    expect(out).not.toContain('brew install');
    expect(out).toContain(`Using the checkout at ${ROOT}`);
    expect(out).toContain('pnpm install --frozen-lockfile');
    expect(out).toContain('infra/local/build-bot-image.sh');
    // No --driver: init keeps a driver the install already has.
    expect(out).toMatch(/fleetadlc\.mjs init$/m);
    expect(out).toContain('fleetadlc.mjs up');
  });

  it('on a Mac, installs what is missing with Homebrew, Docker as OrbStack', () => {
    machine('Darwin', { git: 1, pnpm: 1, tmux: 1, brew: 1, node: 20 });
    const { status, out } = install(['--dry-run']);

    expect(status, out).toBe(0);
    expect(out).toContain('Missing: node 22+ cloudflared docker');
    expect(out).toContain('would run: brew install node cloudflared');
    expect(out).toContain('would run: brew install --cask orbstack');
    expect(out).not.toContain('apt-get');
  });

  it('on Ubuntu with nothing, installs the packages, Node 22, cloudflared and Docker from their own repositories', () => {
    machine('Linux', { 'apt-get': 1, sudo: 1 });
    const { status, out } = install(['--dry-run']);

    expect(status, out).toBe(0);
    expect(out).toMatch(/would run: sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg git tmux python3 make g\+\+/);
    expect(out).toContain('curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -');
    expect(out).toContain('https://pkg.cloudflare.com/cloudflared any main');
    expect(out).toContain('curl -fsSL https://get.docker.com | sudo sh');
    expect(out).toContain('would run: sudo usermod -aG docker');
    expect(out).toContain('curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg');
  });

  it('piped from curl, clones into ~/OpenADLC rather than looking for a checkout it is not in', () => {
    machine('Darwin', { ...EVERYTHING, brew: 1 });
    const { status, out } = install(['--dry-run'], { piped: true });

    expect(status, out).toBe(0);
    expect(out).toContain(`would run: git clone --quiet --branch main https://github.com/620legal/OpenADLC.git ${join(work, 'OpenADLC')}`);
    expect(out).not.toContain('Using the checkout at');
  });

  it('builds and writes the install without starting it, when told not to start', () => {
    machine('Darwin', { ...EVERYTHING, brew: 1 });
    const { status, out } = install(['--dry-run', '--no-start']);

    expect(status, out).toBe(0);
    expect(out).toContain('Installed, not started');
    expect(out).not.toContain('fleetadlc.mjs up');
  });

  it('with --yes, stops rather than settle for the local driver when Docker does not answer', () => {
    machine('Darwin', { ...EVERYTHING, docker: 'silent' });
    const stopped = install(['--dry-run', '--yes']);
    expect(stopped.status).not.toBe(0);
    expect(stopped.out).toContain('pass --local-driver to use the local driver');
    expect(stopped.out).not.toContain('fleetadlc.mjs init');

    const local = install(['--dry-run', '--yes', '--local-driver']);
    expect(local.status, local.out).toBe(0);
    expect(local.out).toContain('this install will use the local driver, as --local-driver says');
    // Written as local, so a stored docker driver does not stay behind the words.
    expect(local.out).toMatch(/fleetadlc\.mjs init --driver local$/m);
    expect(local.out).not.toContain('build-bot-image.sh');
  });

  it('asks before the local driver when a person is there, and shows it in a dry run', () => {
    machine('Darwin', { ...EVERYTHING, docker: 'silent' });
    const { status, out } = install(['--dry-run']);
    expect(status, out).toBe(0);
    expect(out).toContain('Docker is not answering');
    expect(out).toContain('(would ask) Go on without Docker, on the local driver?');
  });

  // Where Homebrew is installed, the script finds it and installs nothing: CI's runners have none.
  it.skipIf(existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew'))('installs Homebrew unattended under --yes', () => {
    machine('Darwin', { git: 1, node: 22, pnpm: 1, tmux: 1, docker: 'answers' });
    const { status, out } = install(['--dry-run', '--yes']);
    expect(status, out).toBe(0);
    expect(out).toContain('would run: env NONINTERACTIVE=1 /bin/bash -c');
    expect(out).toContain('would run: brew install cloudflared');
  });

  describe('on Linux, a Docker that refuses this user', () => {
    let daemon: Server | undefined;
    afterEach(() => {
      daemon?.close();
      daemon = undefined;
    });

    /** A daemon's socket owned by `group`, a docker that says permission denied, and who this user is. */
    async function linux(options: { account: string; shell: string; uid?: number; group?: string }): Promise<void> {
      machine('Linux', { ...EVERYTHING, 'apt-get': 1, sudo: 1, python3: 1, make: 1, 'g++': 1 });
      stub('docker', 'echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" >&2; exit 1');
      stub('stat', `echo ${options.group ?? 'docker'}`);
      daemon = createServer();
      await new Promise<void>((listening) => daemon!.listen(join(work, 'docker.sock'), listening));
      stub(
        'id',
        `case "$*" in
  -u) echo ${options.uid ?? 1000} ;;
  -un) echo tester ;;
  "-nG tester") echo "${options.account}" ;;
  -nG) echo "${options.shell}" ;;
esac`,
      );
    }

    it('adds the user to the docker group, and stops for a new login, a dry run too', async () => {
      await linux({ account: 'tester sudo', shell: 'tester sudo' });
      const { status, out } = install(['--dry-run'], { socket: true });
      expect(status).not.toBe(0);
      expect(out).toContain('would run: sudo usermod -aG docker tester');
      expect(out).toContain('takes effect at your next login');
      expect(out).not.toContain('fleetadlc.mjs init');
    });

    it('asks only for a new login when the account is in the group and this shell is not', async () => {
      await linux({ account: 'tester sudo docker', shell: 'tester sudo' });
      const { status, out } = install(['--dry-run'], { socket: true });
      expect(status).not.toBe(0);
      expect(out).toContain('this shell started before you were');
      expect(out).not.toContain('usermod');
    });

    it('does not take root, which needs no group, for a group problem', async () => {
      await linux({ account: 'root', shell: 'root', uid: 0 });
      const { out } = install(['--dry-run'], { socket: true });
      expect(out).not.toContain('usermod');
      expect(out).toContain('Docker is not answering');
    });

    it('does not take a socket the docker group does not own for a group problem', async () => {
      await linux({ account: 'tester sudo', shell: 'tester sudo', group: 'tester' });
      const { out } = install(['--dry-run'], { socket: true });
      expect(out).not.toContain('usermod');
      expect(out).toContain('Docker is not answering');
    });
  });

  it('hands a root installer no more of the environment than a proxy, as root or through sudo', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).not.toMatch(/^[^#\n]*sudo -E/m);
    const pipe = script.slice(script.indexOf('pipe_to_root() {'), script.indexOf('\n}\n', script.indexOf('pipe_to_root() {')));
    expect(pipe).toMatch(/\| env -i "\$\{clean\[@\]\}" "\$@"/);
    expect(pipe).toMatch(/\| sudo env -i "\$\{clean\[@\]\}" "\$@"/);
  });

  it('refuses an option it does not know, rather than ignoring it', () => {
    machine('Darwin', EVERYTHING);
    const { status, out } = install(['--driver', 'docker']);

    expect(status).not.toBe(0);
    expect(out).toContain('unknown option --driver');
  });
});
