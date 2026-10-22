import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyingRefusal,
  movedTagWords,
  parseImageDigests,
  RELEASE_IMAGE_DIGESTS,
  recordedImageDigests,
  recordsImageDigests,
  checkoutApplyingPath,
  archivePathAllowed,
  attestationCheckArgs,
  attestationRunProblem,
  imageAttestationCheckArgs,
  imageAttestationsUrl,
  readReleasePages,
  RELEASE_IMAGES,
  RELEASE_IMAGE_PLATFORM,
  releaseImageName,
  releaseImageRef,
  builtRootOf,
  checksumOf,
  compareVersions,
  isBuiltRoot,
  isCommitId,
  isServiceKeeper,
  latestRelease,
  otherInstallsRunning,
  recordCheckoutInstall,
  releaseInstallEnv,
  releaseSignerIdentity,
  RELEASE_SIGNER,
  RELEASE_SIGNER_REF,
  safeWords,
  selfUpdateApplyingPath,
  sharedCheckoutReason,
  writeFileDurably,
  parseReleaseManifest,
  parseResultFile,
  RELEASE_CHECKSUMS,
  RELEASE_MANIFEST,
  RELEASE_PREDICATE,
  RELEASE_TAG_FILTER,
  RELEASE_WORKFLOW,
  releaseAssets,
  releaseAssetUrl,
  releaseVersion,
  selfUpdateAttention,
  selfUpdatePaths,
  type PublishedRelease,
  type SelfUpdateLast,
} from './self-update.js';

/**
 * The contract between release.yml and self-update, as
 * docs/self-hosting.md#what-a-release-holds writes it. Each name and format
 * is spelled out here rather than derived, so changing one side alone fails.
 */
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

describe('what a release is called', () => {
  it('is a tag of v and three numbers, with nothing after and no leading zeros', () => {
    expect(releaseVersion('v0.2.0')).toEqual([0, 2, 0]);
    expect(releaseVersion('v12.0.31')).toEqual([12, 0, 31]);
    for (const tag of ['0.2.0', 'v0.2', 'v0.2.0-rc.1', 'v01.2.0', 'v0.02.0', 'version', 'v0.2.0 ', 'refs/tags/v0.2.0']) {
      expect(releaseVersion(tag), tag).toBeNull();
    }
    expect(RELEASE_TAG_FILTER).toBe('v[0-9]+.[0-9]+.[0-9]+');
  });

  it('carries three files by these names', () => {
    expect(releaseAssets('v0.2.0')).toEqual({
      archive: 'openadlc-v0.2.0.tar.gz',
      bundle: 'openadlc-v0.2.0.tar.gz.sigstore.json',
      checksums: 'SHA256SUMS',
    });
    expect(RELEASE_CHECKSUMS).toBe('SHA256SUMS');
    expect(RELEASE_MANIFEST).toBe('openadlc-release.json');
    expect(RELEASE_WORKFLOW).toBe('.github/workflows/release.yml');
    expect(RELEASE_SIGNER).toBe('.github/workflows/release-build.yml');
    expect(RELEASE_SIGNER_REF).toBe('refs/heads/main');
  });

  it('is downloaded from the release’s own address', () => {
    expect(releaseAssetUrl('620legal/OpenADLC', 'v0.2.0', 'openadlc-v0.2.0.tar.gz')).toBe(
      'https://github.com/620legal/OpenADLC/releases/download/v0.2.0/openadlc-v0.2.0.tar.gz',
    );
  });
});

describe('the checksum file', () => {
  const sum = 'c'.repeat(64);

  it('is read in sha256sum’s format, text or binary mode', () => {
    expect(checksumOf(`${sum}  openadlc-v0.2.0.tar.gz\n`, 'openadlc-v0.2.0.tar.gz')).toBe(sum);
    expect(checksumOf(`${sum} *openadlc-v0.2.0.tar.gz\r\n`, 'openadlc-v0.2.0.tar.gz')).toBe(sum);
  });

  it('gives nothing for a name it lacks, two hashes for one name, or a hash that is not one', () => {
    expect(checksumOf(`${sum}  other.tar.gz\n`, 'openadlc-v0.2.0.tar.gz')).toBeNull();
    expect(checksumOf(`${sum}  a\n${'d'.repeat(64)}  a\n`, 'a')).toBeNull();
    expect(checksumOf(`${'C'.repeat(64)}  a\n`, 'a')).toBeNull();
    expect(checksumOf(`${sum} a\n`, 'a')).toBeNull();
  });
});

describe('the manifest inside the archive', () => {
  it('names the tag, the commit and the tree, and nothing else', () => {
    const line = `{"format":1,"tag":"v0.2.0","commit":"${COMMIT}","tree":"${TREE}"}\n`;
    expect(parseReleaseManifest(line)).toEqual({ format: 1, tag: 'v0.2.0', commit: COMMIT, tree: TREE });
    expect(parseReleaseManifest(line.replace('"format":1', '"format":2'))).toBeNull();
    expect(parseReleaseManifest(line.replace('}', ',"extra":true}'))).toBeNull();
    expect(parseReleaseManifest(line.replace(COMMIT, 'main'))).toBeNull();
    expect(parseReleaseManifest('not json')).toBeNull();
  });
});

describe('what an archive may hold', () => {
  it('is the built output at its own paths, and the manifest', () => {
    for (const path of [
      'openadlc-release.json',
      'apps/bridge/dist/main.js',
      'packages/shared/dist/index.d.ts',
      'apps/console/.next/BUILD_ID',
      'apps/console/.next/server/app/api/github/accounts/connect/[flowId]/route.js',
    ]) {
      expect(archivePathAllowed(path, 'file'), path).toBe(true);
    }
    for (const path of ['apps', 'packages/shared', 'apps/bridge/dist', 'apps/console/.next', 'apps/console/.next/server']) {
      expect(archivePathAllowed(path, 'directory'), path).toBe(true);
    }
  });

  it('refuses anything else: source, the build cache, a way out, or a name that is not a path', () => {
    for (const path of [
      'apps/bridge/src/main.ts',
      'package.json',
      'pnpm-lock.yaml',
      'node_modules/x/index.js',
      'apps/hostd/bin/gh',
      '.github/workflows/release.yml',
      'apps/console/.next/cache/webpack/x.pack',
      'apps/bridge/dist/../../../etc/passwd',
      '/etc/passwd',
      './apps/bridge/dist/main.js',
      'apps/bridge/dist//main.js',
      'apps\\bridge\\dist\\main.js',
      'apps/Bridge/dist/main.js',
      'apps/bridge/dist',
    ]) {
      expect(archivePathAllowed(path, 'file'), path).toBe(false);
    }
    expect(archivePathAllowed('apps/console/.next/cache', 'directory')).toBe(false);
    expect(archivePathAllowed('apps/bridge/src', 'directory')).toBe(false);
  });

  it('knows which root a path is in', () => {
    expect(isBuiltRoot('apps/console/.next')).toBe(true);
    expect(isBuiltRoot('packages/db/dist')).toBe(true);
    expect(isBuiltRoot('apps/console')).toBe(false);
    expect(builtRootOf('apps/console/.next/server/app/page.js')).toBe('apps/console/.next');
    expect(builtRootOf('packages/db/dist/cli/migrate.js')).toBe('packages/db/dist');
    expect(builtRootOf('openadlc-release.json')).toBeNull();
  });
});

describe('the attestation check', () => {
  it('is the command the docs give and release.yml runs, flag for flag', () => {
    expect(
      attestationCheckArgs({
        archive: '/d/openadlc-v0.2.0.tar.gz',
        bundle: '/d/openadlc-v0.2.0.tar.gz.sigstore.json',
        repo: '620legal/OpenADLC',
        tag: 'v0.2.0',
        commit: COMMIT,
      }),
    ).toEqual([
      'attestation',
      'verify',
      '/d/openadlc-v0.2.0.tar.gz',
      '--bundle',
      '/d/openadlc-v0.2.0.tar.gz.sigstore.json',
      '--repo',
      '620legal/OpenADLC',
      '--cert-identity',
      'https://github.com/620legal/OpenADLC/.github/workflows/release-build.yml@refs/heads/main',
      '--source-ref',
      'refs/tags/v0.2.0',
      '--source-digest',
      COMMIT,
      '--deny-self-hosted-runners',
      '--predicate-type',
      'https://slsa.dev/provenance/v1',
    ]);
    expect(RELEASE_PREDICATE).toBe('https://slsa.dev/provenance/v1');
    // The reusable workflow at main, whatever called it: a tagged commit's own
    // release.yml signs as itself, and fails this.
    expect(releaseSignerIdentity('acme/openadlc')).toBe('https://github.com/acme/openadlc/.github/workflows/release-build.yml@refs/heads/main');
  });
});

describe('the release to take', () => {
  const release = (tag: string, extra: Partial<PublishedRelease> = {}): PublishedRelease => ({
    tag,
    draft: false,
    prerelease: false,
    publishedAt: '2026-10-01T00:00:00Z',
    assets: Object.values(releaseAssets(tag)),
    immutable: true,
    ...extra,
  });

  it('is the highest version, whatever order GitHub lists them in', () => {
    expect(latestRelease([release('v0.9.0'), release('v0.10.0'), release('v0.2.1')]).release?.tag).toBe('v0.10.0');
    expect(compareVersions([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0);
  });

  it('is never a draft, a prerelease, a tag that is not a version, one missing a file, or one that could still be replaced', () => {
    const { release: chosen, incomplete, mutable } = latestRelease([
      release('v0.6.0', { immutable: false }),
      release('v0.3.0', { draft: true }),
      release('v0.4.0', { prerelease: true }),
      release('nightly'),
      release('v0.5.0', { assets: ['openadlc-v0.5.0.tar.gz', 'SHA256SUMS'] }),
      release('v0.2.0'),
    ]);
    expect(chosen?.tag).toBe('v0.2.0');
    expect(incomplete).toEqual(['v0.5.0']);
    expect(mutable).toEqual(['v0.6.0']);
    expect(latestRelease([]).release).toBeNull();
  });
});

describe('what a run leaves', () => {
  it('keeps its files under the home, and its result beside the services’ logs', () => {
    expect(selfUpdatePaths('/h', 'v0.2.0')).toEqual({
      root: '/h/self-update/v0.2.0',
      download: '/h/self-update/v0.2.0/download',
      tree: '/h/self-update/v0.2.0/tree',
      previous: '/h/self-update/v0.2.0/previous',
      result: '/h/run/self-update-result.json',
      log: '/h/run/self-update.log',
    });
  });

  it('reads the result file the restart wrote, and nothing else', () => {
    const file = { format: 1, state: 'failed', tag: 'v0.2.0', from: COMMIT, to: COMMIT, step: 'install', reason: 'x', restoredTo: COMMIT, finishedAt: 't' };
    expect(parseResultFile(JSON.stringify(file))).toEqual(file);
    expect(parseResultFile(JSON.stringify({ ...file, state: 'waiting' }))).toBeNull();
    expect(parseResultFile('{')).toBeNull();
  });

  it('is a card only when it failed, saying whether the install is still on what it had', () => {
    const last: SelfUpdateLast = {
      state: 'failed',
      trigger: 'schedule',
      actor: 'schedule',
      from: COMMIT,
      to: COMMIT,
      tag: 'v0.2.0',
      reason: 'the attestation did not check',
      step: 'attestation',
      startedAt: 't0',
      finishedAt: 't1',
    };
    expect(selfUpdateAttention(last)).toEqual({
      kind: 'self-update-failed',
      title: 'OpenADLC did not update to v0.2.0 — it is still on the version it had',
      detail: 'attestation: the attestation did not check',
      at: 't1',
      href: '/settings#system',
    });
    expect(selfUpdateAttention({ ...last, to: TREE, step: 'migrate' })?.title).toBe('The OpenADLC update to v0.2.0 did not finish');
    expect(selfUpdateAttention({ ...last, state: 'current' })).toBeNull();
    expect(selfUpdateAttention(null)).toBeNull();
  });
});

describe('what an update runs, and what it keeps', () => {
  // Made up, and built here so that no credential-shaped literal is in the
  // source for the secret scan to find (`.gitleaks.toml`).
  const PAT = `ghp_${'a'.repeat(36)}`;
  const NPM_TOKEN = `npm_SEKRIT1${'a'.repeat(29)}`;
  const PASSWORD = 'hunter2';
  const SIGN_IN = `http://127.0.0.1:47300/signin?token=${[1792600000, '0123abcd'].join('.')}`;

  it('gives a release’s install scripts the tools and the store, and none of the bridge’s secrets', () => {
    const env = releaseInstallEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      HTTPS_PROXY: 'http://proxy:3128',
      PYTHON: '/usr/bin/python3',
      DATABASE_URL: `postgres://openadlc:${PASSWORD}@127.0.0.1:47432/openadlc_db`,
      OPENADLC_WEBHOOK_SECRET: 'whsec',
      OPENADLC_CONSOLE_SECRET: 'console',
      GH_TOKEN: PAT,
      npm_config__authToken: 'npm',
      'npm_config_//registry.npmjs.org/:_authToken': 'npm',
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_store_dir: '/home/me/.pnpm-store',
      npm_config_https_proxy: 'http://proxy:3128',
      npm_config__password: 'pw',
    });
    expect(env).toEqual({
      CI: '1',
      PATH: '/usr/bin',
      HOME: '/home/me',
      HTTPS_PROXY: 'http://proxy:3128',
      PYTHON: '/usr/bin/python3',
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_store_dir: '/home/me/.pnpm-store',
      npm_config_https_proxy: 'http://proxy:3128',
    });
  });

  it('keeps no sign-in token or credential in what it says', () => {
    const said = safeWords(`console   ${SIGN_IN} ${PAT} password=${PASSWORD}`);
    expect(said).not.toContain('0123abcd');
    expect(said).not.toContain(PASSWORD);
    expect(said).not.toContain(PAT);
    expect(said).toContain('signin?token=[redacted]');
  });

  it.each([
    ['access_token=', 'https://x/cb?access_token=SEKRIT1&x=1'],
    ['client_secret=', 'client_secret=SEKRIT1'],
    ['api_key=', 'api_key=SEKRIT1'],
    ['npm’s _authToken=', `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`],
    ['an npm token alone', `npm ERR! token ${NPM_TOKEN} is revoked`],
    ['PGPASSWORD=', 'PGPASSWORD=SEKRIT1 psql'],
    ['an OAuth code=', 'GET /callback?code=SEKRIT1&state=x'],
    ['Authorization: token', 'Authorization: token SEKRIT1'],
    ['Authorization: Bearer', 'authorization: Bearer SEKRIT1'],
    ['Authorization: Basic', 'Authorization: Basic SEKRIT1=='],
    ['JSON "token"', '{"token":"SEKRIT1","ok":true}'],
    ['JSON "client_secret"', '{"client_secret": "SEKRIT1"}'],
    ['the console secret header', 'x-openadlc-console-secret: SEKRIT1'],
  ])('keeps no %s value', (_shape, text) => {
    expect(safeWords(text)).not.toContain('SEKRIT1');
  });

  it('checks a commit id GitHub answers before git is given it', () => {
    expect(isCommitId(COMMIT)).toBe(true);
    for (const value of ['--upload-pack=x', 'main', COMMIT.toUpperCase(), `${COMMIT}\n`, null]) expect(isCommitId(value)).toBe(false);
  });
});

describe('two installs on one checkout', () => {
  it('finds another install running from it, and not a stopped one or itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'checkout-installs-'));
    try {
      const checkout = join(root, 'OpenADLC');
      const [mine, scratch, stopped] = ['mine', 'scratch', 'stopped'].map((name) => join(root, name));
      for (const [home, pid] of [[mine!, 101], [scratch!, 202], [stopped!, 303]] as const) {
        mkdirSync(join(home, 'run'), { recursive: true });
        writeFileSync(join(home, 'run', 'bridge.pid'), `${pid}\n`);
        recordCheckoutInstall(checkout, home);
      }
      const alive = (_service: string, pid: number) => pid === 101 || pid === 202;
      const others = otherInstallsRunning(checkout, mine!, alive);
      expect(others.map((other) => other.home)).toEqual([scratch]);
      expect(otherInstallsRunning(join(root, 'elsewhere'), mine!, alive)).toEqual([]);
      // The way out is named: stop it, or drop a record a crash left.
      expect(sharedCheckoutReason(checkout, others)).toContain(`OPENADLC_HOME=${scratch} openadlc down`);
      expect(sharedCheckoutReason(checkout, others)).toContain(`delete ${others[0]!.record}`);
      expect(existsSync(others[0]!.record)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a pid file a reboot left', () => {
  it('counts only when its pid is that service’s keeper, by its command line', () => {
    const keeper = (line: string | null) => () => line;
    expect(isServiceKeeper('bridge', 4242, keeper('node /x/apps/cli/dist/keep.js bridge --log /h/run/bridge.log -- node /x/apps/bridge/dist/main.js'))).toBe(true);
    // After a reboot the number is some other program's.
    expect(isServiceKeeper('bridge', 4242, keeper('/usr/libexec/coreaudiod'))).toBe(false);
    expect(isServiceKeeper('bridge', 4242, keeper(''))).toBe(false);
    expect(isServiceKeeper('bridge', 4242, keeper('node keep.js console --log x'))).toBe(false);
    // With nothing to say, whether there is a process: this one's is.
    expect(isServiceKeeper('bridge', process.pid, keeper(null))).toBe(true);
  });
});

describe('the run the attestation came from', () => {
  const certificate = (fields: Record<string, unknown>) => JSON.stringify([{ verificationResult: { signature: { certificate: fields } } }]);
  const caller = 'https://github.com/620legal/OpenADLC/.github/workflows/release.yml@refs/tags/v0.2.0';

  it('is the push of the tag, started by release.yml at it', () => {
    expect(attestationRunProblem(certificate({ buildTrigger: 'push', buildConfigURI: caller }), { repo: '620legal/OpenADLC', tag: 'v0.2.0' })).toBeNull();
  });

  it.each([
    ['started by hand', { buildTrigger: 'workflow_dispatch', buildConfigURI: caller }, /started by workflow_dispatch/],
    ['started by another workflow', { buildTrigger: 'push', buildConfigURI: caller.replace('release.yml', 'other.yml') }, /other\.yml/],
    ['for another tag', { buildTrigger: 'push', buildConfigURI: caller.replace('v0.2.0', 'v0.1.0') }, /refs\/tags\/v0\.1\.0, not of/],
  ])('is refused when %s', (_what, fields, reason) => {
    expect(attestationRunProblem(certificate(fields), { repo: '620legal/OpenADLC', tag: 'v0.2.0' })).toMatch(reason);
  });

  it.each([
    ['an entry with no certificate', [{ verificationResult: { signature: {} } }]],
    ['an entry with no verification result', [{ attestation: {} }]],
    ['the fields nested somewhere else', [{ verificationResult: { certificate: { buildTrigger: 'push', buildConfigURI: caller } } }]],
    ['one good entry and one without them', [{ verificationResult: { signature: { certificate: { buildTrigger: 'push', buildConfigURI: caller } } } }, {}]],
    ['something that is not a list', { verificationResult: { signature: { certificate: { buildTrigger: 'push', buildConfigURI: caller } } } }],
  ])('fails closed on %s', (_what, output) => {
    expect(attestationRunProblem(JSON.stringify(output), { repo: '620legal/OpenADLC', tag: 'v0.2.0' })).not.toBeNull();
  });

  it('is refused when gh says nothing it verified', () => {
    expect(attestationRunProblem('[]', { repo: 'a/b', tag: 'v0.2.0' })).toMatch(/verified no attestation/);
    expect(attestationRunProblem('not json', { repo: 'a/b', tag: 'v0.2.0' })).toMatch(/did not print/);
  });
});

describe('a restart cut short', () => {
  it('is refused by up with the ways to finish or go back, until its record is removed', () => {
    const home = mkdtempSync(join(tmpdir(), 'applying-'));
    try {
      expect(applyingRefusal(home)).toBeNull();
      mkdirSync(join(home, 'run'));
      writeFileDurably(
        selfUpdateApplyingPath(home),
        JSON.stringify({ format: 1, tag: 'v0.2.0', from: 'a'.repeat(40), to: 'b'.repeat(40), checkout: '/Users/me/OpenADLC', step: 'output', startedAt: 't' }),
      );
      const refused = applyingRefusal(home);
      expect(refused?.reason).toBe('OpenADLC was restarting onto v0.2.0 and stopped during output, so /Users/me/OpenADLC may hold part of v0.2.0 and part of what it ran before; it is not started like that');
      expect(refused?.steps).toEqual([
        `to finish onto v0.2.0: cd /Users/me/OpenADLC && git merge --ff-only ${'b'.repeat(40)} && pnpm install --frozen-lockfile && pnpm build`,
        `or to go back: cd /Users/me/OpenADLC && git reset --keep ${'a'.repeat(40)} && pnpm install --frozen-lockfile && pnpm build`,
        `if git refuses either (the restart died inside it): rm -f /Users/me/OpenADLC/.git/index.lock, then git reset --hard ${'b'.repeat(40)} to finish or ${'a'.repeat(40)} to go back, and the same pnpm install and build; the checkout had no changes of its own when the restart began`,
        `then: rm ${selfUpdateApplyingPath(home)} && openadlc up`,
      ]);
      // Written whole, through a file beside it that does not stay.
      expect(readdirSync(join(home, 'run'))).toEqual(['self-update-applying.json']);
      expect(JSON.parse(readFileSync(selfUpdateApplyingPath(home), 'utf8')).step).toBe('output');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is refused by another install’s up too, from the record in the checkout they share', () => {
    const root = mkdtempSync(join(tmpdir(), 'applying-checkout-'));
    try {
      const checkout = join(root, 'OpenADLC');
      const scratch = join(root, 'scratch-home');
      mkdirSync(join(checkout, '.openadlc'), { recursive: true });
      writeFileDurably(
        checkoutApplyingPath(checkout),
        JSON.stringify({ format: 1, tag: 'v0.2.0', from: 'a'.repeat(40), to: 'b'.repeat(40), checkout, step: 'merge', startedAt: 't' }),
      );
      expect(applyingRefusal(scratch)).toBeNull();
      expect(applyingRefusal(scratch, checkout)?.reason).toMatch(/stopped during merge/);
      expect(applyingRefusal(scratch, checkout)?.steps.at(-1)).toBe(`then: rm ${checkoutApplyingPath(checkout)} && openadlc up`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the images a release publishes', () => {
  it('names each under the registry in lower case, tagged with the release and nothing else', () => {
    // No bot: it holds Claude Code, which an install may use but a release may not redistribute.
    expect(RELEASE_IMAGES).toEqual(['service', 'console']);
    expect(releaseImageName('620legal/OpenADLC', 'service')).toBe('ghcr.io/620legal/openadlc/service');
    expect(releaseImageRef('620legal/OpenADLC', 'console', 'v0.1.2')).toBe('ghcr.io/620legal/openadlc/console:v0.1.2');
    expect(RELEASE_IMAGE_PLATFORM).toBe('linux/amd64');
  });

  it('checks an image by its digest with the archive’s signer, source and runner', () => {
    const args = imageAttestationCheckArgs({ repo: '620legal/OpenADLC', image: 'console', digest: 'sha256:' + 'a'.repeat(64), tag: 'v0.1.2', commit: 'c'.repeat(40), bundle: 'console.sigstore.json' });
    expect(args.slice(0, 3)).toEqual(['attestation', 'verify', `oci://ghcr.io/620legal/openadlc/console@sha256:${'a'.repeat(64)}`]);
    // From a bundle file, so checking needs no GitHub sign-in, as for the archive.
    expect(args.slice(3, 5)).toEqual(['--bundle', 'console.sigstore.json']);
    expect(imageAttestationsUrl('620legal/OpenADLC', 'sha256:' + 'a'.repeat(64))).toBe(`https://api.github.com/repos/620legal/OpenADLC/attestations/sha256%3A${'a'.repeat(64)}`);
    const archive = attestationCheckArgs({ archive: 'a.tar.gz', bundle: 'a.json', repo: '620legal/OpenADLC', tag: 'v0.1.2', commit: 'c'.repeat(40) });
    // Everything after the subject is the archive's check, flag for flag, less the bundle the registry stands in for.
    const rest = (list: string[]) => list.slice(3).filter((_, i, all) => all[i] !== '--bundle' && all[i - 1] !== '--bundle');
    expect(rest(args)).toEqual(rest(archive));
  });
});

describe('the digests a release records of its images', () => {
  const DIGESTS = { service: `sha256:${'1'.repeat(64)}`, console: `sha256:${'2'.repeat(64)}` };
  /** The file as publish writes it (`jq -c`), and SHA256SUMS with its line after the archive's. */
  const file = (record: unknown = { format: 1, tag: 'v0.2.0', commit: COMMIT, images: DIGESTS }) => Buffer.from(`${JSON.stringify(record)}\n`);
  const sums = (body: Buffer) => `${'f'.repeat(64)}  openadlc-v0.2.0.tar.gz\n${createHash('sha256').update(body).digest('hex')}  images.json\n`;

  it('are in images.json, which a release lists beside its three files, and one from before does not', () => {
    expect(RELEASE_IMAGE_DIGESTS).toBe('images.json');
    const files = Object.values(releaseAssets('v0.2.0'));
    expect(recordsImageDigests({ assets: [...files, 'images.json'] })).toBe(true);
    // v0.1.2 to v0.1.4: their images are taken by their tags, as they always were.
    expect(recordsImageDigests({ assets: files })).toBe(false);
  });

  it('are read only in the one form publish writes', () => {
    expect(parseImageDigests(file().toString())).toEqual({ format: 1, tag: 'v0.2.0', commit: COMMIT, images: DIGESTS });
    for (const record of [
      { format: 2, tag: 'v0.2.0', commit: COMMIT, images: DIGESTS },
      { format: 1, tag: 'latest', commit: COMMIT, images: DIGESTS },
      { format: 1, tag: 'v0.2.0', commit: 'abc', images: DIGESTS },
      { format: 1, tag: 'v0.2.0', commit: COMMIT, images: { service: DIGESTS.service } },
      { format: 1, tag: 'v0.2.0', commit: COMMIT, images: { ...DIGESTS, bot: DIGESTS.service } },
      { format: 1, tag: 'v0.2.0', commit: COMMIT, images: { ...DIGESTS, console: 'v0.2.0' } },
      { format: 1, tag: 'v0.2.0', commit: COMMIT, images: { ...DIGESTS, console: `sha256:${'A'.repeat(64)}` } },
      { format: 1, tag: 'v0.2.0', commit: COMMIT, images: DIGESTS, signed: true },
      [DIGESTS],
    ]) {
      expect(parseImageDigests(JSON.stringify(record)), JSON.stringify(record)).toBeNull();
    }
    expect(parseImageDigests('not json')).toBeNull();
  });

  it('are taken only from the file SHA256SUMS gives, of this release and its commit', () => {
    const body = file();
    expect(recordedImageDigests({ tag: 'v0.2.0', commit: COMMIT, sums: sums(body), file: body })).toEqual({ images: DIGESTS });
    // Which release's commit it is the caller says when it knows; the attestation checks it either way.
    expect(recordedImageDigests({ tag: 'v0.2.0', sums: sums(body), file: body })).toEqual({ images: DIGESTS });
    const refused = (input: Parameters<typeof recordedImageDigests>[0]) => {
      const read = recordedImageDigests(input);
      return 'problem' in read ? read.problem : '';
    };
    expect(refused({ tag: 'v0.2.0', sums: `${'f'.repeat(64)}  openadlc-v0.2.0.tar.gz\n`, file: body })).toMatch(/SHA256SUMS does not give one SHA-256 for images\.json/);
    expect(refused({ tag: 'v0.2.0', sums: sums(body), file: file({ format: 1, tag: 'v0.2.0', commit: COMMIT, images: { ...DIGESTS, console: DIGESTS.service } }) })).toMatch(
      /images\.json has SHA-256 [0-9a-f]{64}, and SHA256SUMS says/,
    );
    const other = file({ format: 1, tag: 'v0.1.0', commit: COMMIT, images: DIGESTS });
    expect(refused({ tag: 'v0.2.0', sums: sums(other), file: other })).toBe("v0.2.0's images.json records the images of v0.1.0");
    expect(refused({ tag: 'v0.2.0', commit: TREE, sums: sums(body), file: body })).toMatch(/records images built from a{40}, not from b{40}, the commit v0\.2\.0 is on/);
    const garbled = Buffer.from('{"format":1}\n');
    expect(refused({ tag: 'v0.2.0', sums: sums(garbled), file: garbled })).toMatch(/not a record of its images' digests/);
  });

  it('say a moved tag by both digests, and which one is taken', () => {
    expect(movedTagWords('620legal/OpenADLC', { tag: 'v0.2.0', image: 'console', recorded: DIGESTS.console, now: `sha256:${'9'.repeat(64)}` })).toBe(
      `ghcr.io/620legal/openadlc/console:v0.2.0 names sha256:${'9'.repeat(64)} now, not ${DIGESTS.console}, the digest v0.2.0 recorded: the tag was pushed again since the release, and the recorded digest is the one taken`,
    );
  });
});

describe('reading the releases page by page', () => {
  const release = (tag: string) => ({ tag, draft: false, prerelease: false, publishedAt: null, assets: [], immutable: true });
  const pages = [['v0.5.0', 'v0.4.0'], ['v0.3.0', 'v0.2.0'], ['v0.1.0']].map((tags) => tags.map(release));

  it('reads on until what is wanted is in, or the list ends', async () => {
    const asked: number[] = [];
    const page = async (n: number) => {
      asked.push(n);
      return pages[n - 1] ?? [];
    };
    expect((await readReleasePages(page, (_, all) => all.some((one) => one.tag === 'v0.3.0'), { perPage: 2 })).map((one) => one.tag)).toEqual(['v0.5.0', 'v0.4.0', 'v0.3.0', 'v0.2.0']);
    expect(asked).toEqual([1, 2]);
    asked.length = 0;
    expect(await readReleasePages(page, () => false, { perPage: 2 })).toHaveLength(5);
    expect(asked).toEqual([1, 2, 3]);
    asked.length = 0;
    expect(await readReleasePages(page, () => false, { perPage: 2, maxPages: 1 })).toHaveLength(2);
  });
});

