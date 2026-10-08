import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `infra/gcp/install.sh` builds a Google Cloud install's images on Cloud Build
 * (`infra/gcp/cloudbuild.yaml`) and then runs the CLI's configure, plan and
 * apply. What it uploads, what it builds, and the order it does things in are
 * checked here; the build itself, and an apply, need a real project.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GCP = join(ROOT, 'infra', 'gcp');

const patterns = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

describe('what Cloud Build is sent', () => {
  it('leaves out everything a local image build leaves out: secrets, tfvars, state, a scratch install', () => {
    const uploaded = new Set(patterns(join(GCP, '.gcloudignore')));
    const missing = patterns(join(ROOT, '.dockerignore')).filter((pattern) => !uploaded.has(pattern));
    expect(missing).toEqual([]);
    for (const secret of ['**/*.tfvars.json', '**/*.tfstate', '**/.env', '**/*.pem', '.scratch']) expect(uploaded).toContain(secret);
  });
});

describe('what Cloud Build builds', () => {
  const build = readFileSync(join(GCP, 'cloudbuild.yaml'), 'utf8');

  it('pushes the four images `fleetadlc cloud configure` offers, under the registry it is given', () => {
    // configure offers `<region>-docker.pkg.dev/<project>/fleetadlc/<name>:latest`.
    const cli = readFileSync(join(ROOT, 'apps', 'cli', 'src', 'commands', 'cloud.ts'), 'utf8');
    for (const name of ['bridge', 'hostd', 'console', 'bot']) {
      expect(cli).toContain(`\${registry}/${name}:latest`);
      expect(build).toContain(`- '\${_REGISTRY}/${name}:\${_TAG}'`);
    }
    expect(build).toMatch(/_TAG: latest/);
  });

  it('builds from the same Dockerfiles and bot script as a laptop, so the two cannot differ', () => {
    expect(build).toContain("'-f', 'infra/local/Dockerfile.service'");
    expect(build).toContain("'-f', 'infra/local/Dockerfile.console'");
    expect(build).toContain("args: ['infra/local/build-bot-image.sh']");
  });
});

describe('infra/gcp/install.sh', () => {
  let work: string;
  let bin: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'gcp-install-'));
    bin = join(work, 'bin');
    mkdirSync(bin);
    for (const tool of ['bash', 'sh', 'cat', 'sed', 'grep', 'head', 'dirname', 'id', 'ls', 'mkdir', 'env', 'uname', 'tr']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found) symlinkSync(found, join(bin, tool));
    }
    // A gcloud signed in, in a project that exists with billing on, where the
    // registry, the builder account and its bucket are already there.
    stub(
      'gcloud',
      `case "$*" in
  *"auth list"*) echo alex@example.com ;;
  *"config get-value project"*) echo acme-openadlc ;;
  *billingEnabled*) echo True ;;
esac
exit 0`,
    );
    stub('terraform', 'echo "Terraform v1.9.8"');
    stub('pnpm');
    // Its version, and the real Node for the one-liners the script runs.
    stub('node', `case "$1" in -p) echo 22 ;; *) exec "${process.execPath}" "$@" ;; esac`);
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  function stub(name: string, body = 'exit 0'): void {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }

  function install(args: string[]): { status: number | null; out: string } {
    const run = spawnSync(join(bin, 'bash'), [join(GCP, 'install.sh'), '--dry-run', ...args], {
      env: { PATH: bin, HOME: work, TERM: 'dumb' },
      encoding: 'utf8',
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  }

  it('builds as its own account, from a bucket of its own, then configures, plans and applies, in that order', () => {
    const { status, out } = install(['--project', 'acme-openadlc']);
    expect(status, out).toBe(0);

    const submit = out.split('\n').find((line) => line.includes('gcloud builds submit')) ?? '';
    expect(submit).toContain('--config infra/gcp/cloudbuild.yaml');
    expect(submit).toContain('--ignore-file infra/gcp/.gcloudignore');
    expect(submit).toContain('_REGISTRY=us-central1-docker.pkg.dev/acme-openadlc/fleetadlc');
    expect(submit).toContain('--service-account projects/acme-openadlc/serviceAccounts/openadlc-image-builder@acme-openadlc.iam.gserviceaccount.com');
    expect(submit).toContain('--gcs-source-staging-dir gs://acme-openadlc-openadlc-build/source');

    const order = ['gcloud builds submit', 'cloud configure', 'cloud plan', 'cloud apply'].map((step) => out.indexOf(step));
    expect(order.every((at) => at >= 0), out).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('gives the build bucket its delete rule from a file in the checkout, a bucket that is there already too', () => {
    // gcloud storage cannot open a <(…) pipe: a fresh install stopped there,
    // with the bucket made and no rule on it (issue #1).
    const { status, out } = install(['--project', 'acme-openadlc']);
    expect(status, out).toBe(0);
    const update = out.split('\n').find((line) => line.includes('gcloud storage buckets update gs://acme-openadlc-openadlc-build')) ?? '';
    const file = /--lifecycle-file=(\S+)/.exec(update)?.[1] ?? '';
    expect(file, out).toBe(join(ROOT, 'infra', 'gcp', 'build-bucket-lifecycle.json'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ rule: [{ action: { type: 'Delete' }, condition: { age: 7 } }] });
  });

  describe('Terraform', () => {
    // Cloud Shell's /google/bin/terraform prints how to install Terraform and
    // exits 0: a plan and an apply "passed" through it with nothing created.
    const placeholder = 'echo; echo "  Follow the instructions at https://developer.hashicorp.com/terraform/install to install terraform"';

    it('installs nothing when the terraform here is Terraform 1.6 or later', () => {
      const { status, out } = install(['--project', 'acme-openadlc', '--plan-only']);
      expect(status, out).toBe(0);
      expect(out).not.toContain('releases.hashicorp.com');
    });

    it("downloads HashiCorp's release into ~/.local/bin, checked against its sums, over Cloud Shell's placeholder", () => {
      stub('terraform', placeholder);
      stub('curl');
      stub('unzip');
      const run = spawnSync(join(bin, 'bash'), [join(GCP, 'install.sh'), '--dry-run', '--project', 'acme-openadlc', '--plan-only'], {
        env: { PATH: bin, HOME: work, TERM: 'dumb', OPENADLC_TERRAFORM_VERSION: '1.9.8' },
        encoding: 'utf8',
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(run.status, out).toBe(0);
      expect(out).toContain('is not Terraform 1.6 or later');
      expect(out).toContain(`Install Terraform 1.9.8 from releases.hashicorp.com into ${join(work, '.local', 'bin')}?`);
      expect(out).toContain('https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_linux_');
      expect(out).toContain('check it against SHA256SUMS');
    });

    it('uses the Terraform an earlier run put in ~/.local/bin, ahead of the placeholder', () => {
      stub('terraform', placeholder);
      mkdirSync(join(work, '.local', 'bin'), { recursive: true });
      writeFileSync(join(work, '.local', 'bin', 'terraform'), '#!/bin/sh\necho "Terraform v1.9.8"\n');
      chmodSync(join(work, '.local', 'bin', 'terraform'), 0o755);
      const { status, out } = install(['--project', 'acme-openadlc', '--plan-only']);
      expect(status, out).toBe(0);
      expect(out).not.toContain('releases.hashicorp.com');
    });

    it('stops rather than plan with a Terraform older than the module needs, when it cannot install one', () => {
      stub('terraform', 'echo "Terraform v1.5.7"');
      const { status, out } = install(['--project', 'acme-openadlc', '--plan-only']);
      expect(status, out).not.toBe(0);
      expect(out).toContain('installing Terraform needs curl');
      expect(out).not.toContain('cloud plan');
    });
  });

  it('builds nothing with --skip-images, and stops at the plan with --plan-only', () => {
    const { status, out } = install(['--project', 'acme-openadlc', '--skip-images', '--plan-only']);
    expect(status, out).toBe(0);
    expect(out).not.toContain('gcloud builds submit');
    expect(out).toContain('fleetadlc.mjs cloud plan');
    expect(out).not.toContain('fleetadlc.mjs cloud apply');
    expect(out).toContain('Stopped after the plan');
  });

  it('takes over the settings in the project\'s bucket before configure, rather than start them again', () => {
    const { status, out } = install(['--project', 'acme-openadlc', '--skip-images']);
    expect(status, out).toBe(0);
    const pull = out.indexOf('cloud pull --bucket acme-openadlc-fleetadlc-tfstate');
    expect(pull, out).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(out.indexOf('cloud configure'));
    expect(out).toContain('Enter keeps it');
    expect(out).not.toContain('leave it empty');
  });

  it('asks a new install for its domain, and to leave the client id to the walkthrough', () => {
    stub(
      'gcloud',
      `case "$*" in
  *"auth list"*) echo alex@example.com ;;
  *billingEnabled*) echo True ;;
  *"storage objects describe"*) echo "ERROR: (gcloud.storage.objects.describe) gs://acme-openadlc-fleetadlc-tfstate/fleetadlc/cloud.tfvars.json not found: 404." >&2; exit 1 ;;
esac
exit 0`,
    );
    const { status, out } = install(['--project', 'acme-openadlc', '--skip-images']);
    expect(status, out).toBe(0);
    expect(out).not.toContain('cloud pull');
    expect(out).toContain('a new install');
    expect(out).toContain('leave it empty');
  });

  it('configures nothing when it cannot tell whether the bucket holds settings', () => {
    stub(
      'gcloud',
      `case "$*" in
  *"auth list"*) echo alex@example.com ;;
  *billingEnabled*) echo True ;;
  *"storage objects describe"*) echo "ERROR: (gcloud.storage.objects.describe) HTTPError 403: alex@example.com does not have storage.objects.get access" >&2; exit 1 ;;
esac
exit 0`,
    );
    const { status, out } = install(['--project', 'acme-openadlc', '--skip-images']);
    expect(status).not.toBe(0);
    expect(out).toContain('could not tell whether gs://acme-openadlc-fleetadlc-tfstate holds');
    expect(out).toContain('HTTPError 403');
    expect(out).not.toContain('cloud configure');
  });

  it.each([
    ['is not JSON', '{ project_id: acme'],
    ['names no project', JSON.stringify({ region: 'us-central1' })],
  ])('stops when this machine\'s settings file %s, rather than start the settings again', (_, body) => {
    mkdirSync(join(work, '.fleetadlc'));
    writeFileSync(join(work, '.fleetadlc', 'cloud.tfvars.json'), body);
    const { status, out } = install(['--project', 'acme-openadlc', '--skip-images']);
    expect(status).not.toBe(0);
    expect(out).toContain("is not an install's settings");
    expect(out).not.toContain('cloud configure');
  });

  it('stops when this machine holds another install\'s settings, rather than offer them for this one', () => {
    mkdirSync(join(work, '.fleetadlc'));
    writeFileSync(join(work, '.fleetadlc', 'cloud.tfvars.json'), JSON.stringify({ project_id: 'other-install' }));
    const { status, out } = install(['--project', 'acme-openadlc', '--skip-images']);
    expect(status).not.toBe(0);
    expect(out).toContain('holds the settings of the install in other-install');
    expect(out).not.toContain('cloud configure');
  });

  it('will not create a project without knowing whose bill it goes on', () => {
    stub(
      'gcloud',
      `case "$*" in
  *"auth list"*) echo alex@example.com ;;
  *"projects describe"*) exit 1 ;;
  *"billing accounts list"*) printf '0X0X0X-0X0X0X-0X0X0X\\n1Y1Y1Y-1Y1Y1Y-1Y1Y1Y\\n' ;;
esac
exit 0`,
    );
    const { status, out } = install(['--project', 'acme-openadlc']);
    expect(status).not.toBe(0);
    expect(out).toContain('--billing-account <id>');
    expect(out).not.toContain('projects create');
  });
});
