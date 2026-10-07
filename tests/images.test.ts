import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A file the bot image copies onto its PATH has to be executable *in git*.
 *
 * `COPY` preserves the source file's mode, and git stores it: a script committed
 * at 100644 lands in the image as `-rw-r--r--`, and the container's entrypoint
 * then fails with `exec /usr/local/bin/bot-init failed: Permission denied` — in
 * a restart loop, forever, on every bot at once.
 *
 * That is what `infra/local/bot-init` was. It is not something a reader notices,
 * it is not something `docker build` complains about, and on a machine where the
 * file happens to be executable in the working tree it does not reproduce. Only
 * the index says.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(join(ROOT, 'infra', 'local', 'Dockerfile.bot'), 'utf8');

/**
 * What `COPY <src> /usr/local/bin/<dst>` names from the build context, by
 * source path. A `COPY --from=<stage>` copies out of another image, where git
 * has no say in the mode.
 */
function copiedToPath(): string[] {
  return [...dockerfile.matchAll(/^COPY\s+((?:--[\w=:-]+\s+)*)(\S+)\s+\/usr\/local\/bin\//gm)]
    .filter((match) => !/--from=/.test(match[1] ?? ''))
    .map((match) => match[2]!);
}

/** The mode git has recorded, not the one this working tree happens to have. */
function indexMode(path: string): string {
  const line = execFileSync('git', ['ls-files', '-s', '--', path], { cwd: ROOT, encoding: 'utf8' }).trim();
  return line.split(/\s+/)[0] ?? '';
}

describe('what the bot image puts on the PATH', () => {
  const copied = copiedToPath();

  it('copies something', () => {
    // Guards the parser: if the Dockerfile's COPY lines change shape and
    // nothing matches, every assertion below passes without checking anything.
    expect(copied.length).toBeGreaterThan(0);
  });

  it.each(copied)('%s is executable in the index', (source) => {
    expect(indexMode(join('infra', 'local', source)), `${source} is not committed executable`).toBe('100755');
  });
});

/**
 * hostd's weekly engine update builds the bot image by running
 * `infra/local/build-bot-image.sh` from the directory hostd runs in. On the
 * cloud host that directory is the service image's `/app`, copied out onto the
 * host — and the service image carried none of `infra/`, so the update there
 * could only say the script was not there. Every file the build reads has to be
 * in the service image, at the path the script expects beside itself.
 */
describe('what the service image carries for the weekly engine update', () => {
  const service = readFileSync(join(ROOT, 'infra', 'local', 'Dockerfile.service'), 'utf8');
  /** The stage hostd runs from: everything after the last `FROM`. */
  const runtime = service.slice(service.lastIndexOf('\nFROM '));
  const workdir = runtime.match(/^WORKDIR\s+(\S+)/m)?.[1] ?? '/';

  /** Where a file from the build context lands, for each `COPY` that takes it. */
  function landed(source: string): string[] {
    const where: string[] = [];
    for (const match of runtime.matchAll(/^COPY\s+(?!--from)(?:--[\w=:-]+\s+)*(.+)$/gm)) {
      const words = match[1]!.trim().split(/\s+/);
      const dest = words.pop()!;
      const base = dest.startsWith('/') ? dest : join(workdir, dest);
      for (const src of words.map((word) => word.replace(/\/$/, ''))) {
        if (src === source) {
          where.push(dest.endsWith('/') || words.length > 1 ? join(base, source.split('/').pop()!) : base);
        } else if (source.startsWith(`${src}/`)) {
          where.push(join(base, source.slice(src.length + 1)));
        }
      }
    }
    return where;
  }

  /** What the build reads: the script, the Dockerfile, and what the Dockerfile copies from its context. */
  const needed = [
    'infra/local/build-bot-image.sh',
    'infra/local/Dockerfile.bot',
    ...[...dockerfile.matchAll(/^COPY\s+(?!--from)(?:--[\w=:-]+\s+)*(\S+)\s+\S+$/gm)].map(
      (match) => `infra/local/${match[1]!}`,
    ),
  ];

  it('knows what the bot image copies', () => {
    // Guards the parser, as above.
    expect(needed).toContain('infra/local/bot-init');
  });

  it.each(needed)('has %s where hostd looks for it', (source) => {
    expect(landed(source), `infra/local/Dockerfile.service does not copy ${source} into the image`).toContain(
      join(workdir, source),
    );
  });

  it('has a docker CLI to build with', () => {
    expect(runtime).toMatch(/\b(?:docker\.io|docker-ce-cli)\b/);
  });
});

/**
 * hostd's terminal gateway loads node-pty, which has prebuilt binaries only for
 * macOS and Windows; on Linux it is compiled. Both installs in the service
 * image pass `--ignore-scripts` and the stage had no compiler, so the image
 * never held a node-pty that loaded, and every take-over from the console's
 * Terminal tab, on compose and on the cloud host, said "could not attach:
 * Failed to load native module".
 */
describe('node-pty in the service image', () => {
  const service = readFileSync(join(ROOT, 'infra', 'local', 'Dockerfile.service'), 'utf8');
  const lastFrom = service.lastIndexOf('\nFROM ');
  const build = service.slice(0, lastFrom);
  const runtime = service.slice(lastFrom);

  it('is compiled in the build stage, after the production install that would throw it away', () => {
    expect(build).toMatch(/apt-get install -y --no-install-recommends[\s\\]+python3 make g\+\+/);
    const prodInstall = build.lastIndexOf('pnpm install --prod');
    const rebuild = build.indexOf('pnpm --filter @fleetadlc/hostd rebuild node-pty');
    expect(prodInstall).toBeGreaterThan(-1);
    expect(rebuild).toBeGreaterThan(prodInstall);
    // And loaded once, so a module that did not build fails the image build.
    expect(build.indexOf(`node -e "require('node-pty')"`)).toBeGreaterThan(rebuild);
  });

  it('leaves the compiler out of the runtime stage', () => {
    expect(runtime).not.toMatch(/\bg\+\+|build-essential|\bmake\b/);
  });
});

/**
 * The candidate is swapped in only after this script has seen the pinned
 * version. A glob let 2.6.1 pass for an image that had 2.6.10.
 */
function versionIs(said: string, want: string): boolean {
  try {
    execFileSync(join(ROOT, 'infra/local/build-bot-image.sh'), ['--version-is', said, want], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('the bot image proves the exact Node and gh versions', () => {
  it('accepts the version node and gh print, and refuses a longer one that only starts the same way', () => {
    expect(versionIs('v22.20.0', 'v22.20.0')).toBe(true);
    expect(versionIs('v22.20.0', 'v22.2')).toBe(false);
    expect(versionIs('v22.20.01', 'v22.20.0')).toBe(false);
    expect(versionIs('gh version 2.6.10 (2026-01-01)', '2.6.10')).toBe(true);
    expect(versionIs('gh version 2.6.1 (2026-01-01)', '2.6.1')).toBe(true);
    expect(versionIs('gh version 2.6.10 (2026-01-01)', '2.6.1')).toBe(false);
  });
});

/** What `build-bot-image.sh` keeps gh from, with a `docker` on the PATH whose builder has `driver`. */
function ghFrom(image: string, driver: string | null): string {
  const bin = mkdtempSync(join(tmpdir(), 'fleetadlc-docker-'));
  try {
    const answer = driver === null ? 'exit 1' : `printf 'Name: b\\nDriver: %s\\n' '${driver}'; exit 0`;
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nif [ "$1" = buildx ] && [ "$2" = inspect ]; then ${answer}; fi\nexit 1\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    return execFileSync(join(ROOT, 'infra/local/build-bot-image.sh'), ['--gh-from', image], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('keeping the running image’s gh', () => {
  it('keeps it on Docker’s own builder, and on the classic one, which see this host’s images', () => {
    expect(ghFrom('fleetadlc-bot:latest', 'docker')).toBe('fleetadlc-bot:latest');
    expect(ghFrom('fleetadlc-bot:latest', null)).toBe('fleetadlc-bot:latest');
  });

  it('installs from the apt repository on a builder that cannot see the image, rather than failing to pull it', () => {
    expect(ghFrom('fleetadlc-bot:latest', 'docker-container')).toBe('');
    expect(ghFrom('', 'docker')).toBe('');
  });
});

describe('what the images built from the repository root take with them', () => {
  const ignored = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n').map((line) => line.trim());

  it('leaves out what is not source: a scratch install, local settings, keys and an install’s own prices', () => {
    // `COPY apps/console` copied apps/console/.env.local, and `COPY config` an
    // install's config/models.yaml, into an image that is pushed to a registry.
    for (const pattern of ['**/node_modules', '.scratch', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/secrets', '.git', 'config/models.yaml']) {
      expect(ignored, pattern).toContain(pattern);
    }
    // Nothing an image copies is left out with them.
    for (const pattern of ['packages', 'apps', 'config', 'crew', 'infra', 'LICENSE', 'NOTICE']) {
      expect(ignored, pattern).not.toContain(pattern);
    }
  });

  it.each(['Dockerfile.service', 'Dockerfile.console'])('%s carries OpenADLC’s LICENSE and NOTICE', (file) => {
    const body = readFileSync(join(ROOT, 'infra', 'local', file), 'utf8');
    expect(body).toMatch(/^COPY LICENSE NOTICE /m);
  });

  it('ships the third-party licences with the console, whose icons they cover', () => {
    // Lucide's ISC licence asks for its notice in every copy; the image is one.
    const body = readFileSync(join(ROOT, 'infra', 'local', 'Dockerfile.console'), 'utf8');
    expect(body).toMatch(/^COPY LICENSE NOTICE THIRD_PARTY_NOTICES /m);
    expect(ignored).not.toContain('THIRD_PARTY_NOTICES');
  });

  it('keeps NOTICE to the attribution Apache-2.0 asks redistributors to carry', () => {
    // Everything in NOTICE has to travel with every redistribution; who
    // answers for an install is said in docs/security.md, and the warranty in LICENSE.
    expect(readFileSync(join(ROOT, 'NOTICE'), 'utf8')).toBe('OpenADLC\nCopyright 2026 620 Legal\n\nThis product includes software developed by 620 Legal.\n');
  });

  it('keeps sharp, and its LGPL libvips, out of the console it does nothing for', () => {
    // Next brings sharp as an optional dependency, for next/image, which the
    // console does not use; pruning dev dependencies would not remove it.
    expect(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/^ignoredOptionalDependencies:\n {2}- sharp$/m);
    expect(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')).not.toContain('sharp-libvips');
  });

  it('builds and starts the console with Next.js’s telemetry off', () => {
    // `next build` reported anonymous usage from every image build.
    const body = readFileSync(join(ROOT, 'infra', 'local', 'Dockerfile.console'), 'utf8');
    const [build, run] = body.split(/^FROM /m).slice(1);
    expect(build).toMatch(/NEXT_TELEMETRY_DISABLED=1/);
    expect(build!.indexOf('NEXT_TELEMETRY_DISABLED')).toBeLessThan(build!.indexOf('console build'));
    expect(run).toMatch(/NEXT_TELEMETRY_DISABLED=1/);
  });

  it.each(['Dockerfile.service', 'Dockerfile.console'])('%s runs as the image’s node user, not root', (file) => {
    // Neither set a USER, so the bridge, which parses webhooks from the
    // internet and holds the secret store, and the console ran as root under
    // compose and on Cloud Run.
    const body = readFileSync(join(ROOT, 'infra', 'local', file), 'utf8');
    const final = body.split(/^FROM /m).pop() ?? '';
    const instructions = final.split('\n').filter((line) => /^[A-Z]+ /.test(line));
    expect(instructions.at(-1)).toBe('USER node');
  });

  it('gives the console’s files to node, which Next.js writes its cache under', () => {
    const final = readFileSync(join(ROOT, 'infra', 'local', 'Dockerfile.console'), 'utf8').split(/^FROM /m).pop() ?? '';
    expect(final).toMatch(/^COPY --from=build --chown=node:node \/app \/app$/m);
  });

  it('makes the bridge’s webhook-secret directory node’s, so a new volume over it is', () => {
    const final = readFileSync(join(ROOT, 'infra', 'local', 'Dockerfile.service'), 'utf8').split(/^FROM /m).pop() ?? '';
    expect(final).toMatch(/^RUN mkdir -p \/var\/lib\/fleetadlc && chown node:node \/var\/lib\/fleetadlc$/m);
  });

  it('keeps Node’s own LICENSE when it unpacks a named release', () => {
    // It carries the notices for V8, OpenSSL and ICU, built into the binary.
    expect(dockerfile).toMatch(/linux-\$\{node_arch\}\/LICENSE" \/usr\/local\/share\/doc\/node\/LICENSE/);
  });
});
