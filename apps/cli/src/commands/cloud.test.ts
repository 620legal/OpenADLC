import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageAttestationCheckArgs, releaseAssets } from '@openadlc/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureDefaults,
  afterTerraform,
  applyShouldResetHost,
  askRequired,
  backendArgs,
  canonicalRepository,
  checkedReleaseImages,
  chooseUpdate,
  cloudBuildImages,
  configuredImages,
  configuredVars,
  consoleUsers,
  DEFAULT_DEPLOYER_WORKFLOW,
  defaultOperators,
  goBackCommand,
  hostNeedsReset,
  hostResetArgs,
  imagesInUse,
  INSTANCE_NAME,
  invalidMember,
  LEGACY_NAME_PREFIX,
  memberArguments,
  membersCommand,
  mirrorDigest,
  mirrorImage,
  newestReleaseImages,
  type MembersRunners,
  NAME_PREFIX,
  noAdminWarning,
  normalizedMembers,
  outputAnswer,
  pinNamePrefix,
  postApplySteps,
  releaseDigest,
  releaseMirror,
  remoteTfVars,
  rollSteps,
  settledAnswers,
  terraformProblem,
  tfVars,
  updateCommand,
  withAddedMembers,
  writeCloudFiles,
  type CloudConfig,
  type ReleaseRunners,
  type UpdateRunners,
} from './cloud.js';

const cloud: CloudConfig = {
  provider: 'gcp',
  projectId: 'example-project',
  region: 'us-central1',
  zone: 'us-central1-a',
  organization: 'example-org',
  githubClientId: 'Iv1.example',
  humans: ['ada'],
  consoleDomain: 'openadlc.example.com',
  bridgeImage: 'r/bridge:latest',
  consoleImage: 'r/console:latest',
  hostdImage: 'r/hostd:latest',
  botImage: 'r/bot:latest',
  consoleMembers: ['user:ada@example.com'],
  adminEmails: ['ada@example.com'],
  operators: ['user:ada@example.com'],
  webhookSecret: 'generated',
};

describe('the module inputs configure writes', () => {
  it('names every variable the module requires, so apply does not stop to ask', () => {
    // console_domain and webhook_secret are required and were never written:
    // the first apply of the module stopped on both.
    const variables = readFileSync(join(import.meta.dirname, '../../../../infra/gcp/variables.tf'), 'utf8');
    const required = [...variables.matchAll(/variable "([a-z_]+)" \{([^}]*)\}/g)]
      .filter(([, , body]) => !/\bdefault\s*=/.test(body ?? ''))
      .map(([, name]) => name);
    expect(required.length).toBeGreaterThan(0);
    expect(Object.keys(tfVars(cloud, 47312))).toEqual(expect.arrayContaining(required));
  });
});

describe('where the alerts go', () => {
  it('passes notification channels only when some are given, so an empty answer keeps the module’s default', () => {
    expect(tfVars(cloud, 47312)).not.toHaveProperty('notification_channels');
    expect(tfVars({ ...cloud, notificationChannels: [] }, 47312)).not.toHaveProperty('notification_channels');
    const channel = 'projects/example-project/notificationChannels/123';
    expect(tfVars({ ...cloud, notificationChannels: [channel] }, 47312)).toMatchObject({ notification_channels: [channel] });
  });
});

describe('what is left by hand after an apply', () => {
  it('points the app’s webhook at webhook_url and says where its secret is, never at the bridge URL', () => {
    // It pointed at `bridge_url`, the internal Cloud Run address, which GitHub
    // cannot reach: a webhook set there delivered nothing, and the board
    // stayed empty.
    const steps = postApplySteps('/home/ada/.openadlc/cloud.tfvars.json', 'openadlc.example.com').join('\n');
    expect(steps).toContain('webhook_url');
    expect(steps).toContain('GitHub App’s webhook');
    expect(steps).toContain('webhook_secret in /home/ada/.openadlc/cloud.tfvars.json');
    expect(steps).toContain('console’s webhook step');
    expect(steps).not.toMatch(/bridge_url|bridge URL|organization/i);
  });

  it('tells the operator to run nothing on the host, which has no openadlc', () => {
    for (const domain of ['openadlc.example.com', '']) {
      const steps = postApplySteps('/home/ada/.openadlc/cloud.tfvars.json', domain);
      for (const step of steps) {
        expect(step).not.toMatch(/openadlc (auth|doctor|github|restore)/);
        expect(step).not.toMatch(/on the host/i);
      }
      const text = steps.join('\n');
      expect(text).toContain('GitHub accounts step');
      expect(text).toContain('health cards');
      expect(text).toContain('webhook card');
    }
  });

  it('asks for a DNS record only when the operator named a domain', () => {
    // With no domain the console is on the install's own address under nip.io,
    // which resolves with no record of theirs: a DNS step would be a lie.
    const named = postApplySteps('/home/ada/.openadlc/cloud.tfvars.json', 'openadlc.example.com')[0];
    expect(named).toContain('point DNS');
    expect(named).toContain('console_ip');
    const defaulted = postApplySteps('/home/ada/.openadlc/cloud.tfvars.json')[0];
    expect(defaulted).toContain('nip.io');
    expect(defaulted).toContain('console_url');
    expect(defaulted).toContain('"console_domain" in /home/ada/.openadlc/cloud.tfvars.json');
    expect(defaulted).not.toMatch(/^point DNS/);
  });
});

describe('a repository allowed to deploy', () => {
  it('is passed only when one is named, so the module creates nothing for an install without one', () => {
    expect(tfVars(cloud, 47312)).not.toHaveProperty('deployer_repository');
    expect(tfVars({ ...cloud, deployerRepository: 'example-org/deploy' }, 47312)).toMatchObject({
      deployer_repository: 'example-org/deploy',
    });
  });

  it('passes the ids it is admitted by and its one workflow, only with a repository', () => {
    // The provider admits the repository by its numeric ids and one workflow
    // file; by name, a renamed repository's name could be taken.
    const ids = { deployerRepositoryId: '123456', deployerRepositoryOwnerId: '7890', deployerWorkflow: '.github/workflows/ship.yml' };
    const none = tfVars({ ...cloud, ...ids }, 47312);
    for (const key of ['deployer_repository_id', 'deployer_repository_owner_id', 'deployer_workflow']) expect(none).not.toHaveProperty(key);
    expect(tfVars({ ...cloud, ...ids, deployerRepository: 'example-org/deploy' }, 47312)).toMatchObject({
      deployer_repository: 'example-org/deploy',
      deployer_repository_id: '123456',
      deployer_repository_owner_id: '7890',
      deployer_workflow: '.github/workflows/ship.yml',
    });
    expect(tfVars({ ...cloud, deployerRepository: 'example-org/deploy' }, 47312)).toMatchObject({
      deployer_workflow: DEFAULT_DEPLOYER_WORKFLOW,
    });
  });
});

describe('where an install keeps its state and settings', () => {
  it('is the install’s own bucket, passed at init rather than written in the module', () => {
    expect(backendArgs({ bucket: 'b', prefix: 'openadlc' })).toEqual([
      '-reconfigure',
      '-backend-config=bucket=b',
      '-backend-config=prefix=openadlc',
    ]);
    const backendTf = readFileSync(join(import.meta.dirname, '../../../../infra/gcp/backend.tf'), 'utf8');
    expect(backendTf).toMatch(/backend "gcs" \{\}/);
  });

  it('keeps the settings beside the state', () => {
    expect(remoteTfVars({ bucket: 'b', prefix: 'openadlc' })).toBe('gs://b/openadlc/cloud.tfvars.json');
  });

  it('names a new install OpenADLC, and says so in its settings', () => {
    expect(tfVars(cloud, 47312)).toMatchObject({ name_prefix: NAME_PREFIX });
    expect(pinNamePrefix(tfVars(cloud, 47312))).toMatchObject({ pinned: false, vars: { name_prefix: NAME_PREFIX } });
  });

  it('pins the old name on settings written before the rename, so applying them replaces nothing', () => {
    const { name_prefix: _, ...before } = tfVars(cloud, 47312);
    const { vars, pinned } = pinNamePrefix(before);
    expect(pinned).toBe(true);
    expect(vars).toMatchObject({ ...before, name_prefix: LEGACY_NAME_PREFIX });
  });
});

describe('the repository the deployer admits', () => {
  const github = (answers: Record<string, unknown>) => async (url: string) => {
    const name = url.replace('https://api.github.com/repos/', '').toLowerCase();
    const found = answers[name];
    return { ok: found !== undefined, json: async () => found };
  };

  it('takes GitHub’s spelling, capitals included, which is what the token’s claim carries', async () => {
    // Typed in lower case, it refused every deploy at token exchange.
    const lookup = github({ 'exampleco/deploys': { full_name: 'ExampleCo/Deploys' } });
    expect(await canonicalRepository('exampleco/deploys', lookup)).toEqual({ name: 'ExampleCo/Deploys', checked: true });
  });

  it('reads the repository’s id and its owner’s from the same answer, as the strings the token carries', async () => {
    const lookup = github({ 'exampleco/deploys': { full_name: 'ExampleCo/Deploys', id: 123456, owner: { id: 7890 } } });
    expect(await canonicalRepository('exampleco/deploys', lookup)).toEqual({
      name: 'ExampleCo/Deploys',
      checked: true,
      id: '123456',
      ownerId: '7890',
    });
    // Anything but a positive id is left for the person to give.
    const odd = github({ 'exampleco/deploys': { full_name: 'ExampleCo/Deploys', id: '12 OR 1', owner: { id: 7890 } } });
    expect(await canonicalRepository('exampleco/deploys', odd)).toEqual({ name: 'ExampleCo/Deploys', checked: true });
  });

  it('keeps what was typed when GitHub will not show it, and says it was not checked', async () => {
    expect(await canonicalRepository('exampleco/private', github({}))).toEqual({ name: 'exampleco/private', checked: false });
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    };
    expect(await canonicalRepository('exampleco/deploys', offline)).toEqual({ name: 'exampleco/deploys', checked: false });
  });

  it('asks nothing about what is not owner/name', async () => {
    let asked = false;
    const lookup = async () => {
      asked = true;
      return { ok: false, json: async () => null };
    };
    expect(await canonicalRepository('../../orgs/exampleco', lookup)).toEqual({ name: '../../orgs/exampleco', checked: false });
    expect(asked).toBe(false);
  });
});

describe('configure run again on an install that has settings', () => {
  // Every run made a new webhook secret and wrote the answers alone: re-run to
  // set the deployer, it rotated the secret GitHub signs with, dropped
  // admin_emails, and reset a pre-rename install's prefix to openadlc.
  const { webhookSecret: _secret, ...answers } = cloud;
  const fresh = () => 'f'.repeat(64);
  const existing = {
    ...tfVars({ ...cloud, webhookSecret: 'kept-secret' }, 47312),
    name_prefix: 'openadlc',
    admin_emails: ['ada@example.com'],
    host_machine_type: 'e2-standard-8',
  };

  it('keeps the webhook secret, and makes none', () => {
    let made = 0;
    const vars = configuredVars(existing, { ...answers, deployerRepository: 'exampleco/deploys' }, 47312, () => {
      made += 1;
      return fresh();
    });
    expect(vars.webhook_secret).toBe('kept-secret');
    expect(made).toBe(0);
    expect(vars.deployer_repository).toBe('exampleco/deploys');
  });

  it('carries over what it does not ask about', () => {
    expect(configuredVars(existing, answers, 47312, fresh).host_machine_type).toBe('e2-standard-8');
  });

  it('keeps the name prefix the install has, and pins the old one for settings from before the rename', () => {
    expect(configuredVars({ ...existing, name_prefix: 'custom' }, answers, 47312, fresh).name_prefix).toBe('custom');
    const { name_prefix: _prefix, ...preRename } = existing;
    expect(configuredVars(preRename, answers, 47312, fresh).name_prefix).toBe(LEGACY_NAME_PREFIX);
  });

  it('makes a secret for a new install, with the new prefix, as before', () => {
    const vars = configuredVars(undefined, answers, 47312, () => randomBytes(32).toString('hex'));
    expect(vars.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(vars.name_prefix).toBe(NAME_PREFIX);
    const empty = configuredVars({ ...existing, webhook_secret: '' }, answers, 47312, fresh);
    expect(empty.webhook_secret).toBe(fresh());
  });
});

describe('the console’s first admins', () => {
  // configure never asked, so an install whose console let people in by group
  // or domain only had no admin, and every visitor was refused.
  it('are written as admin_emails, even when nobody is named', () => {
    expect(tfVars(cloud, 47312)).toMatchObject({ admin_emails: ['ada@example.com'] });
    expect(tfVars({ ...cloud, adminEmails: [] }, 47312)).toMatchObject({ admin_emails: [] });
  });

  it('default to the console members that name a person, without the user: prefix', () => {
    expect(consoleUsers(['user:ada@example.com', 'group:eng@example.com', 'domain:example.com'])).toEqual(['ada@example.com']);
    expect(consoleUsers(['group:eng@example.com'])).toEqual([]);
  });

  it('are warned about, with the fix, when they name nobody', () => {
    const warning = noAdminWarning([], '/home/ada/.openadlc/cloud.tfvars.json');
    expect(warning).toContain('no admin');
    expect(warning).toContain('"admin_emails": ["you@example.com"]');
    expect(warning).toContain('/home/ada/.openadlc/cloud.tfvars.json');
    expect(warning).toContain('openadlc cloud apply');
    expect(noAdminWarning(['ada@example.com'], '/home/ada/.openadlc/cloud.tfvars.json')).toBeNull();
  });
});

describe('what configure writes on a machine with no install', () => {
  it('makes $OPENADLC_HOME and writes the settings and the backend there, private', () => {
    // On a laptop that never ran a local install, the write failed with ENOENT
    // after every question was answered, and the answers were lost.
    const scratch = mkdtempSync(join(tmpdir(), 'openadlc-cloud-'));
    const home = join(scratch, 'not', 'yet');
    const before = process.env.OPENADLC_HOME;
    process.env.OPENADLC_HOME = home;
    try {
      writeCloudFiles(tfVars(cloud, 47312), { bucket: 'b', prefix: 'openadlc' });
      expect(JSON.parse(readFileSync(join(home, 'cloud.tfvars.json'), 'utf8'))).toMatchObject({ project_id: 'example-project' });
      expect(statSync(join(home, 'cloud.tfvars.json')).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(home, 'cloud.backend.json'), 'utf8'))).toEqual({ bucket: 'b', prefix: 'openadlc' });
      expect(statSync(home).mode & 0o777).toBe(0o700);
    } finally {
      if (before === undefined) delete process.env.OPENADLC_HOME;
      else process.env.OPENADLC_HOME = before;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a cloud configure question that needs an answer', () => {
  // The example sat in parentheses, where prompt() shows a default, and Enter
  // wrote an empty answer into the settings.
  it('is asked again until it has one, and takes a default when there is one', async () => {
    const answers = ['', '  ', 'user:ada@example.com'];
    const asked: string[] = [];
    const ask = async (question: string, fallback?: string) => {
      asked.push(question);
      return answers.shift() || fallback || '';
    };
    expect(await askRequired(ask, 'who may open the console, e.g. user:you@example.com')).toBe('user:ada@example.com');
    expect(asked).toHaveLength(3);
    expect(await askRequired(async (_question, fallback) => fallback ?? '', 'who may open the console', 'user:ada@example.com')).toBe('user:ada@example.com');
  });
});

// What `terraform output` prints — on stdout, exiting 0 — on a state with no
// outputs, which is what an apply that ended in an error leaves behind.
const NO_OUTPUTS_WARNING = [
  '╷',
  '│ Warning: No outputs found',
  '│',
  '│ The state file either has no outputs defined, or all the defined outputs',
  '│ are empty. Please define an output in your configuration with the',
  '│ `output` keyword and run `terraform refresh` for it to become available.',
  '╵',
].join('\n');

describe('what a terraform output read answers', () => {
  it('is not the "No outputs found" warning, which terraform prints on stdout exiting 0', () => {
    // The warning was once read back as the host's name, and gcloud was asked
    // to reset an instance named by the whole warning.
    expect(outputAnswer('host_name', { code: 0, stdout: NO_OUTPUTS_WARNING })).toBeNull();
    expect(outputAnswer('host_rollout', { code: 0, stdout: NO_OUTPUTS_WARNING })).toBeNull();
  });

  it('is nothing when the read printed nothing', () => {
    expect(outputAnswer('host_name', { code: 0, stdout: '' })).toBeNull();
    expect(outputAnswer('host_name', { code: 0, stdout: '\n' })).toBeNull();
  });

  it('is nothing when the read exited with an error, whatever it printed', () => {
    expect(outputAnswer('host_name', { code: 1, stdout: 'openadlc-host-1\n' })).toBeNull();
  });

  it('is the host name when it is one as GCE allows them', () => {
    expect(outputAnswer('host_name', { code: 0, stdout: 'openadlc-host-1\n' })).toBe('openadlc-host-1');
  });

  it('is never a host name gcloud could read as something else', () => {
    expect(outputAnswer('host_name', { code: 0, stdout: '--zone=elsewhere' })).toBeNull();
    expect(outputAnswer('host_name', { code: 0, stdout: 'Host-1' })).toBeNull();
  });

  it('is a host name only up to the 63 characters GCE allows', () => {
    const longest = `a${'b'.repeat(61)}c`;
    expect(longest).toHaveLength(63);
    expect(INSTANCE_NAME.test(longest)).toBe(true);
    expect(INSTANCE_NAME.test(`${longest}d`)).toBe(false);
  });

  it('is never a host name GCE would refuse to have named', () => {
    expect(INSTANCE_NAME.test('openadlc-host-1')).toBe(true);
    expect(INSTANCE_NAME.test('openadlc-host-')).toBe(false);
    expect(INSTANCE_NAME.test('1openadlc-host')).toBe(false);
    expect(INSTANCE_NAME.test('Openadlc-host-1')).toBe(false);
    expect(INSTANCE_NAME.test('openadlc-HOST-1')).toBe(false);
  });

  it('is the rollout when it is one line', () => {
    const rollout = 'ab12'.repeat(16);
    expect(outputAnswer('host_rollout', { code: 0, stdout: `${rollout}\n` })).toBe(rollout);
  });
});

describe('the host after an apply', () => {
  it('is reset when its cloud-init or database settings changed, since a restart runs the old prepare script', () => {
    expect(hostNeedsReset({ host: 'openadlc-host-1', rollout: 'a' }, 'b')).toBe(true);
  });

  it('is reset once when its state predates the value, which is the apply that turns TLS on', () => {
    expect(hostNeedsReset({ host: 'openadlc-host-1', rollout: null }, 'b')).toBe(true);
  });

  it('is left alone when nothing it runs on changed', () => {
    expect(hostNeedsReset({ host: 'openadlc-host-1', rollout: 'a' }, 'a')).toBe(false);
  });

  it('is left alone when this apply made it, because it booted on the new settings', () => {
    expect(hostNeedsReset({ host: null, rollout: null }, 'b')).toBe(false);
  });

  it('is reset when the apply failed after the rollout changed, not only when it exited 0', () => {
    // Terraform committed the new database URL and then failed on a later
    // resource. The host kept the old prepare script and lost the database.
    const before = { host: 'openadlc-host-1', rollout: 'a' };
    expect(applyShouldResetHost('apply', before, 'b')).toBe(true);
  });

  it('is left alone when a failed apply did not change what the host runs on', () => {
    expect(applyShouldResetHost('apply', { host: 'openadlc-host-1', rollout: 'a' }, 'a')).toBe(false);
  });

  it('is left alone by a plan, which does not change the host', () => {
    expect(applyShouldResetHost('plan', { host: 'openadlc-host-1', rollout: 'a' }, 'b')).toBe(false);
  });

  it('is reset by the apply command when Terraform exited 1 after the rollout had changed', async () => {
    const ran: string[][] = [];
    const pushed: string[] = [];
    await afterTerraform(
      'apply',
      1,
      { host: 'openadlc-host-1', rollout: 'a' },
      { zone: 'us-central1-b', project_id: 'example-project' },
      {
        run: async (command, args) => {
          ran.push([command, ...args]);
          return 0;
        },
        outputValue: async (name) => (name === 'host_rollout' ? 'b' : null),
        push: async () => {
          pushed.push('settings');
          return 0;
        },
      },
    );
    expect(ran).toEqual([['gcloud', ...hostResetArgs('openadlc-host-1', 'us-central1-b', 'example-project')]]);
    // A failed apply's settings are not the ones the next operator should find.
    expect(pushed).toEqual([]);
  });

  it('is left alone when the outputs could not be read, because there is nothing to decide with', () => {
    expect(hostNeedsReset({ host: null, rollout: null }, null)).toBe(false);
  });

  it('is never reset by a name that is not one, even handed past the reads', () => {
    expect(hostNeedsReset({ host: NO_OUTPUTS_WARNING, rollout: 'a' }, 'b')).toBe(false);
  });

  it('is not reset, and the operator is sent back to apply, when a failed apply left no outputs', async () => {
    // The live first apply of a fresh project: the alert-policy race ended it
    // in an error, Terraform wrote no outputs, and the host the apply had just
    // made was reset by a garbled name. No outputs is no decision.
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void printed.push(String(line ?? '')));
    const ran: string[][] = [];
    try {
      await afterTerraform(
        'apply',
        1,
        { host: null, rollout: null },
        { zone: 'us-central1-b', project_id: 'example-project' },
        {
          run: async (command, args) => {
            ran.push([command, ...args]);
            return 0;
          },
          outputValue: async () => null,
          push: async () => 0,
        },
      );
    } finally {
      log.mockRestore();
    }
    expect(ran).toEqual([]);
    const said = printed.join('\n');
    expect(said).toContain('no outputs');
    expect(said).toContain('openadlc cloud apply again');
  });

  it('is handed to the operator to reset by hand when the rollout could not be read under a known host', async () => {
    // The note once said a finished apply would decide it. It does not: the
    // next apply compares only its own before and after, and a rollout this
    // one committed reads the same on both sides of it, so the host kept the
    // old prepare script and lost the database.
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void printed.push(String(line ?? '')));
    const ran: string[][] = [];
    try {
      await afterTerraform(
        'apply',
        1,
        { host: 'openadlc-host-1', rollout: 'a' },
        { zone: 'us-central1-b', project_id: 'example-project' },
        {
          run: async (command, args) => {
            ran.push([command, ...args]);
            return 0;
          },
          outputValue: async () => null,
          push: async () => 0,
        },
      );
    } finally {
      log.mockRestore();
    }
    expect(ran).toEqual([]);
    const said = printed.join('\n');
    expect(said).toContain('whether openadlc-host-1 must be reset was not decided');
    expect(said).toContain(`gcloud ${hostResetArgs('openadlc-host-1', 'us-central1-b', 'example-project').join(' ')}`);
    expect(said).toContain('a later apply will not decide it');
    expect(said).not.toContain('decides it');
    // The apply itself still failed, and has to be run again to finish.
    expect(said).toContain('typically because the apply ended in an error');
    expect(said).toContain('openadlc cloud apply again');
  });

  it.each([
    ['a known host', 'openadlc-host-1'],
    ['no host known before it', null],
  ])('says the apply ended in an error only when it did, with %s', async (_, host) => {
    // An apply that exited 0 and whose read after it failed (the state bucket
    // unreachable, say) was told it had typically ended in an error.
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void printed.push(String(line ?? '')));
    vi.stubEnv('OPENADLC_HOME', join(tmpdir(), 'openadlc-cloud-no-home'));
    const ran: string[][] = [];
    try {
      await afterTerraform(
        'apply',
        0,
        { host, rollout: 'a' },
        { zone: 'us-central1-b', project_id: 'example-project' },
        {
          run: async (command, args) => {
            ran.push([command, ...args]);
            return 0;
          },
          outputValue: async () => null,
          push: async () => 0,
        },
      );
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(ran).toEqual([]);
    const said = printed.join('\n');
    expect(said).toContain('could not be read after the apply');
    expect(said).not.toContain('ended in an error');
    const reset = `gcloud ${hostResetArgs('openadlc-host-1', 'us-central1-b', 'example-project').join(' ')}`;
    if (host) {
      // A step under "Still to do by hand", since the apply itself finished.
      expect(said).toContain('Still to do by hand');
      expect(said.slice(said.indexOf('Still to do by hand'))).toContain(reset);
    } else {
      expect(said).not.toContain(reset);
    }
  });

  it('never puts what is not a host name on a gcloud command line, even handed one past the reads', async () => {
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void printed.push(String(line ?? '')));
    const ran: string[][] = [];
    try {
      await afterTerraform(
        'apply',
        1,
        { host: NO_OUTPUTS_WARNING, rollout: NO_OUTPUTS_WARNING },
        { zone: 'us-central1-b', project_id: 'example-project' },
        {
          run: async (command, args) => {
            ran.push([command, ...args]);
            return 0;
          },
          outputValue: async () => 'b',
          push: async () => 0,
        },
      );
    } finally {
      log.mockRestore();
    }
    expect(ran).toEqual([]);
    // And never echoes it back as a command to run by hand.
    expect(printed.join('\n')).not.toContain('No outputs found');
  });

  it('never names what is not a host name in the note that sends the operator back to apply', async () => {
    // hostNeedsReset keeps it off gcloud's command line; the note that the
    // outputs are gone is built from the same before-read, and would have
    // named the whole warning as the host.
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void printed.push(String(line ?? '')));
    try {
      await afterTerraform(
        'apply',
        1,
        { host: NO_OUTPUTS_WARNING, rollout: null },
        { zone: 'us-central1-b', project_id: 'example-project' },
        { run: async () => 0, outputValue: async () => null, push: async () => 0 },
      );
    } finally {
      log.mockRestore();
    }
    const said = printed.join('\n');
    expect(said).toContain('openadlc cloud apply again');
    expect(said).not.toContain('No outputs found');
  });

  it('is reset by name, in its zone and project', () => {
    expect(hostResetArgs('openadlc-host-1', 'us-central1-a', 'example-project')).toEqual([
      'compute',
      'instances',
      'reset',
      'openadlc-host-1',
      '--zone',
      'us-central1-a',
      '--project',
      'example-project',
    ]);
  });
});

describe('what configure offers a new install', () => {
  it('takes the project, region, console members and domain infra/gcp/install.sh found', () => {
    expect(
      configureDefaults({
        OPENADLC_CLOUD_PROJECT: 'acme-openadlc',
        OPENADLC_CLOUD_REGION: 'europe-west1',
        OPENADLC_CLOUD_CONSOLE_MEMBERS: 'user:alex@example.com',
        OPENADLC_CLOUD_DOMAIN: 'openadlc.example.com',
      }),
    ).toEqual({
      projectId: 'acme-openadlc',
      region: 'europe-west1',
      consoleMembers: 'user:alex@example.com',
      domain: 'openadlc.example.com',
    });
  });

  it('offers nothing it was not given, so a blank does not become an answer', () => {
    expect(configureDefaults({ OPENADLC_CLOUD_PROJECT: '  ', OPENADLC_CLOUD_REGION: '' })).toEqual({
      projectId: undefined,
      region: undefined,
      consoleMembers: undefined,
      domain: undefined,
    });
  });
});

describe('the answers configure no longer asks for', () => {
  const existing = {
    project_id: 'held-project',
    region: 'europe-west1',
    zone: 'europe-west1-b',
    github_organization: 'held-org',
    github_app_client_id: 'Iv1.held',
    humans: ['ada', 'grace'],
    console_domain: 'held.example.com',
    console_members: ['user:held@example.com'],
    notification_channels: ['projects/p/notificationChannels/1'],
  };

  it('leaves a fresh install with one question, whose default is the signed-in gcloud account', () => {
    const answers = settledAnswers({}, undefined, {}, { project: 'gcloud-project', account: 'ada@example.com' });
    expect(answers).toEqual({
      projectId: 'gcloud-project',
      region: 'us-central1',
      zone: 'us-central1-a',
      organization: '',
      githubClientId: '',
      humans: [],
      consoleDomain: '',
      membersGiven: null,
      membersDefault: 'user:ada@example.com',
      notificationChannels: [],
    });
  });

  it('refuses nothing itself: a project nobody named is null, for configure to say so', () => {
    expect(settledAnswers({}, undefined, {}, {}).projectId).toBeNull();
    expect(settledAnswers({}, undefined, {}, {}).membersDefault).toBeUndefined();
  });

  it('takes a flag over the install’s settings, and the settings over install.sh’s seeds', () => {
    const offered = { projectId: 'seeded', region: 'us-east1', consoleMembers: 'user:seed@example.com', domain: 'seed.example.com' };
    const kept = settledAnswers({}, existing, offered, { project: 'gcloud-project', account: 'g@example.com' });
    expect(kept.projectId).toBe('held-project');
    expect(kept.region).toBe('europe-west1');
    expect(kept.zone).toBe('europe-west1-b');
    expect(kept.organization).toBe('held-org');
    expect(kept.consoleDomain).toBe('held.example.com');
    expect(kept.membersDefault).toBe('user:held@example.com');
    expect(kept.humans).toEqual(['ada', 'grace']);
    expect(kept.notificationChannels).toEqual(['projects/p/notificationChannels/1']);

    const flagged = settledAnswers(
      { project: 'flagged', region: 'asia-east1', domain: 'flag.example.com', members: 'user:flag@example.com', organization: 'flag-org' },
      existing,
      offered,
      {},
    );
    expect(flagged.projectId).toBe('flagged');
    expect(flagged.region).toBe('asia-east1');
    // The zone follows the flagged region rather than keeping the old one's.
    expect(flagged.zone).toBe('asia-east1-a');
    expect(flagged.consoleDomain).toBe('flag.example.com');
    expect(flagged.organization).toBe('flag-org');
    expect(flagged.membersGiven).toBe('user:flag@example.com');
  });

  it('writes the GitHub pair and the domain empty on a fresh install, for onboarding and nip.io to fill', () => {
    const answers = settledAnswers({}, undefined, { projectId: 'p', region: 'us-central1' }, {});
    const vars = tfVars(
      {
        ...cloud,
        organization: answers.organization,
        githubClientId: answers.githubClientId,
        consoleDomain: answers.consoleDomain,
        humans: answers.humans,
      },
      47312,
    );
    expect(vars).toMatchObject({ github_organization: '', github_app_client_id: '', console_domain: '', humans: [] });
  });

  it('clears the domain back to the nip.io default with an empty --domain, over kept settings', () => {
    expect(settledAnswers({ domain: '' }, existing, {}, {}).consoleDomain).toBe('');
  });
});

describe('who may take over a terminal when nobody is named', () => {
  it('is the console members that are people, never a group or a domain', () => {
    expect(defaultOperators(['user:ada@example.com', 'group:eng@example.com', 'domain:example.com'])).toEqual(['user:ada@example.com']);
    expect(defaultOperators(['group:eng@example.com'])).toEqual([]);
  });
});

describe('letting someone into the console with cloud members add', () => {
  it('reads what follows the subcommand, passing flags and their values over', () => {
    expect(memberArguments(['add', 'a@b.com', '--provider', 'gcp'])).toEqual(['add', 'a@b.com']);
    expect(memberArguments(['add', '--provider=gcp', 'a@b.com', '--no-apply'])).toEqual(['add', 'a@b.com']);
    expect(memberArguments([])).toEqual([]);
  });

  it('refuses a word that is no IAM member, so a typo cannot become user:typo', () => {
    expect(invalidMember('a@b.com')).toBeNull();
    expect(invalidMember('user:a@b.com')).toBeNull();
    expect(invalidMember('group:crew@example.com')).toBeNull();
    expect(invalidMember('serviceAccount:ci@p.iam.gserviceaccount.com')).toBeNull();
    expect(invalidMember('domain:example.com')).toBeNull();
    expect(invalidMember('gcp')).toContain('not an email address');
    expect(invalidMember('user:')).toContain('not an email address');
    expect(invalidMember('domain:a b')).toContain('does not name a domain');
    expect(invalidMember('domain:a@b.com')).toContain('does not name a domain');
    expect(invalidMember('role:admin')).toContain('is not an IAM member');
  });

  it('admits each address once, however either side capitalises it', () => {
    expect(withAddedMembers(['user:jane@example.com'], ['bob@example.com', 'Jane@Example.com'])).toEqual({
      members: ['user:jane@example.com', 'user:bob@example.com'],
      added: ['user:bob@example.com'],
      already: ['user:Jane@Example.com'],
    });
    // A group kept as typed, and a list that already has everyone changes nothing.
    expect(withAddedMembers([], ['group:crew@example.com']).members).toEqual(['group:crew@example.com']);
    expect(withAddedMembers(['user:a@b.com'], ['a@b.com']).added).toEqual([]);
  });

  it('knows a bare address settings from before the user: prefix still hold, so it is not added beside itself', () => {
    expect(withAddedMembers(['jane@example.com'], ['jane@example.com', 'user:JANE@example.com'])).toEqual({
      members: ['jane@example.com'],
      added: [],
      already: ['user:jane@example.com', 'user:JANE@example.com'],
    });
  });
});

describe('the cloud members add command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const backend = { bucket: 'openadlc-state', prefix: 'openadlc' };

  /** Runners that record what the command did, and what it printed. */
  function runners(settings: Record<string, unknown> | undefined, codes: { push?: number; apply?: number } = {}) {
    const did: string[] = [];
    const written: Record<string, unknown>[] = [];
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(line));
    const given: MembersRunners = {
      backend: () => (settings === undefined ? null : backend),
      settings: async () => settings,
      write: (vars) => {
        did.push('write');
        written.push(vars);
      },
      push: async () => {
        did.push('push');
        return codes.push ?? 0;
      },
      apply: async () => {
        did.push('apply');
        return codes.apply ?? 0;
      },
    };
    return { given, did, written, printed };
  }

  it('appends the person, keeps every other setting, then saves and applies as cloud apply does', async () => {
    const { given, did, written } = runners({ project_id: 'example-project', console_members: ['user:ada@example.com'] }, { apply: 3 });
    expect(await membersCommand(['add', 'bob@example.com'], false, given)).toBe(3);
    expect(did).toEqual(['write', 'push', 'apply']);
    expect(written).toEqual([{ project_id: 'example-project', console_members: ['user:ada@example.com', 'user:bob@example.com'] }]);
  });

  it('changes nothing for an address already listed, exits 0 and points to cloud apply in case it never went out', async () => {
    const { given, did, printed } = runners({ console_members: ['jane@example.com'] });
    expect(await membersCommand(['add', 'Jane@example.com'], false, given)).toBe(0);
    expect(did).toEqual([]);
    expect(printed.join('\n')).toContain('openadlc cloud apply');
  });

  it('fails with what to do, and writes nothing, on a machine with no cloud configuration', async () => {
    const { given, did, printed } = runners(undefined);
    expect(await membersCommand(['add', 'bob@example.com'], false, given)).toBe(1);
    expect(did).toEqual([]);
    expect(printed.join('\n')).toContain('openadlc cloud configure');
  });

  it('refuses an address that is not one, and writes nothing', async () => {
    const { given, did } = runners({ console_members: [] });
    expect(await membersCommand(['add', 'gcp'], false, given)).toBe(2);
    expect(await membersCommand(['add'], false, given)).toBe(2);
    expect(did).toEqual([]);
  });

  it('saves without applying under --no-apply, and stops at a push that failed', async () => {
    const saved = runners({ console_members: [] });
    expect(await membersCommand(['add', 'bob@example.com'], true, saved.given)).toBe(0);
    expect(saved.did).toEqual(['write', 'push']);
    vi.restoreAllMocks();

    const failed = runners({ console_members: [] }, { push: 1 });
    expect(await membersCommand(['add', 'bob@example.com'], false, failed.given)).toBe(1);
    expect(failed.did).toEqual(['write', 'push']);
  });
});

describe('the one answer a fresh install gives', () => {
  // The natural answer is a bare email. Taken as typed it was no IAM member at
  // all — IAP admitted nobody — and consoleUsers saw no `user:` either, so the
  // install also had no admin and configure warned about it right after
  // accepting the answer that should have named one.
  const derived = (answer: string) => {
    const members = normalizedMembers(answer.split(',').map((entry) => entry.trim()).filter(Boolean));
    return { members, admins: consoleUsers(members), operators: defaultOperators(members) };
  };

  it('makes a bare email the console member, the first admin and the operator', () => {
    expect(derived('zelig@620legal.com')).toEqual({
      members: ['user:zelig@620legal.com'],
      admins: ['zelig@620legal.com'],
      operators: ['user:zelig@620legal.com'],
    });
  });

  it('takes a user:-prefixed answer as typed, with the admin unprefixed', () => {
    expect(derived('user:ada@example.com')).toEqual({
      members: ['user:ada@example.com'],
      admins: ['ada@example.com'],
      operators: ['user:ada@example.com'],
    });
  });

  it('makes Enter on the offered default a working admin too', () => {
    // install.sh seeds the default as `user:<account>`, and a bare gcloud
    // account becomes one: either way Enter must leave an admin behind.
    const offered = settledAnswers({}, undefined, {}, { account: 'ada@example.com' }).membersDefault;
    expect(offered).toBe('user:ada@example.com');
    expect(derived(offered ?? '')).toEqual({
      members: ['user:ada@example.com'],
      admins: ['ada@example.com'],
      operators: ['user:ada@example.com'],
    });
  });

  it('still leaves a group or a domain without an admin, which noAdminWarning says', () => {
    const { members, admins } = derived('group:eng@example.com,domain:example.com');
    expect(members).toEqual(['group:eng@example.com', 'domain:example.com']);
    expect(admins).toEqual([]);
    expect(noAdminWarning(admins, '/home/ada/.openadlc/cloud.tfvars.json')).toContain('no admin');
  });

  it('mixes types without touching the typed ones', () => {
    expect(normalizedMembers(['ada@example.com', 'group:eng@example.com', 'serviceAccount:x@p.iam.gserviceaccount.com'])).toEqual([
      'user:ada@example.com',
      'group:eng@example.com',
      'serviceAccount:x@p.iam.gserviceaccount.com',
    ]);
  });
});

describe('the terraform a plan or an apply runs', () => {
  const answer = (code: number, stdout: string) => ({ code, stdout, stderr: '' });

  it('takes Terraform 1.6 or later', () => {
    expect(terraformProblem(answer(0, '{"terraform_version":"1.6.0","platform":"linux_amd64"}'))).toBeNull();
    expect(terraformProblem(answer(0, '{"terraform_version":"1.12.2"}'))).toBeNull();
  });

  it("refuses Cloud Shell's placeholder, which prints how to install Terraform and exits 0", () => {
    const placeholder = '\n  Follow the instructions at https://developer.hashicorp.com/terraform/install to install terraform, or run the commands below:\n';
    expect(terraformProblem(answer(0, placeholder))).toMatch(/not Terraform.*infra\/gcp\/install\.sh/);
  });

  it('refuses a Terraform older than the module needs, and says when there is none', () => {
    expect(terraformProblem(answer(0, '{"terraform_version":"1.5.7"}'))).toMatch(/Terraform 1\.5\.7/);
    expect(terraformProblem(answer(127, ''))).toMatch(/not installed/);
  });
});

// ------------------------------------------------------------------ release images

const REPO = '620legal/OpenADLC';
const MIRROR = 'us-central1-docker.pkg.dev/example-project/openadlc-ghcr';
const sha = (hex: string) => `sha256:${hex.repeat(64 / hex.length)}`;
const commitOf = (tag: string) => createHash('sha1').update(tag).digest('hex');

interface World {
  releases: { tag: string; draft?: boolean; immutable?: boolean; assets?: string[] }[];
  /** `<tag>/<image>` whose attestation gh refuses, with what it says. */
  refused?: Record<string, string>;
  /** `<tag>/<image>` whose attestation was made by another trigger than the tag's push. */
  dispatched?: string[];
  /** `<tag>/<image>` ghcr.io does not show without a sign-in. */
  hidden?: string[];
  /** `<tag>/<image>` GitHub's attestations API has nothing for. */
  unattested?: string[];
  /** ghcr.io does not answer at all. */
  offline?: boolean;
}

/**
 * GitHub and ghcr.io, stood in for: the releases `gh api` lists, the commits
 * their tags are on, each image's manifest (its digest is the manifest's
 * hash), the attestations API's bundles for each digest, and `gh attestation
 * verify`, which accepts only the arguments the shared contract gives, with
 * the file of exactly those bundles, and answers as `--format json` does.
 */
function releaseWorld(world: World) {
  const gh: string[][] = [];
  const verified: string[][] = [];
  const got: { url: string; headers: Record<string, string> }[] = [];
  const manifest = (tag: string, image: string) => Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', tag, image }));
  const digestOf = (body: Buffer) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const published = (tag: string) => world.releases.some((release) => release.tag === tag);
  const byDigest = new Map<string, { tag: string; image: 'service' | 'console' }>();
  for (const { tag } of world.releases) for (const image of ['service', 'console'] as const) byDigest.set(digestOf(manifest(tag, image)), { tag, image });
  const digest = (tag: string, image: 'service' | 'console') => digestOf(manifest(tag, image));
  const bundles = (key: string) => [{ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', of: key, n: 1 }, { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', of: key, n: 2 }];
  const runners: ReleaseRunners = {
    gh: async (args) => {
      gh.push(args);
      const listing = /^repos\/620legal\/OpenADLC\/releases\?per_page=100(?:&page=(\d+))?$/.exec(args[1] ?? '');
      if (args[0] === 'api' && listing) {
        const page = Number(listing[1] ?? '1');
        const listed = world.releases.slice((page - 1) * 100, page * 100).map((release) => ({
          tag_name: release.tag,
          draft: release.draft ?? false,
          prerelease: false,
          published_at: '2026-10-01T00:00:00Z',
          immutable: release.immutable ?? true,
          assets: (release.assets ?? Object.values(releaseAssets(release.tag))).map((name) => ({ name })),
        }));
        return { code: 0, stdout: JSON.stringify(listed), stderr: '' };
      }
      const commit = /^repos\/620legal\/OpenADLC\/commits\/(v[0-9.]+)$/.exec(args[1] ?? '');
      if (args[0] === 'api' && commit && published(commit[1]!)) return { code: 0, stdout: `${commitOf(commit[1]!)}\n`, stderr: '' };
      return { code: 1, stdout: '', stderr: `gh ${args.join(' ')}: not stood in for` };
    },
    verify: async (args) => {
      verified.push(args);
      const subject = /^oci:\/\/ghcr\.io\/620legal\/openadlc\/(service|console)@(sha256:[0-9a-f]{64})$/.exec(args[2] ?? '');
      const found = subject ? byDigest.get(subject[2]!) : undefined;
      if (!subject || !found || found.image !== subject[1]) return { code: 1, stdout: '', stderr: 'no attestations found' };
      const bundle = args[args.indexOf('--bundle') + 1] ?? '';
      const expected = [...imageAttestationCheckArgs({ repo: REPO, image: found.image, digest: subject[2]!, tag: found.tag, commit: commitOf(found.tag), bundle }), '--format', 'json'];
      if (JSON.stringify(args) !== JSON.stringify(expected)) return { code: 1, stdout: '', stderr: `unexpected arguments: ${args.join(' ')}` };
      const key = `${found.tag}/${found.image}`;
      // The file holds every bundle the API gave, one JSON line each.
      const lines = readFileSync(bundle, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
      if (JSON.stringify(lines) !== JSON.stringify(bundles(key))) return { code: 1, stdout: '', stderr: `the bundle file is not the API's: ${JSON.stringify(lines)}` };
      if (world.refused?.[key]) return { code: 1, stdout: '', stderr: world.refused[key]! };
      const trigger = world.dispatched?.includes(key) ? 'workflow_dispatch' : 'push';
      const certificate = { buildTrigger: trigger, buildConfigURI: `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/${found.tag}` };
      return { code: 0, stdout: JSON.stringify([{ verificationResult: { signature: { certificate } } }]), stderr: '' };
    },
    get: async (url, headers) => {
      got.push({ url, headers });
      const attestations = /^https:\/\/api\.github\.com\/repos\/620legal\/OpenADLC\/attestations\/sha256%3A([0-9a-f]{64})$/.exec(url);
      if (attestations) {
        const found = byDigest.get(`sha256:${attestations[1]}`);
        if (!found || world.unattested?.includes(`${found.tag}/${found.image}`)) return { status: 404, body: Buffer.from('{"message":"Not Found"}') };
        return { status: 200, body: Buffer.from(JSON.stringify({ attestations: bundles(`${found.tag}/${found.image}`).map((bundle) => ({ bundle, repository_id: 1 })) })) };
      }
      if (world.offline) throw new Error('could not reach ghcr.io: getaddrinfo ENOTFOUND ghcr.io');
      const token = /^https:\/\/ghcr\.io\/token\?scope=repository%3A(620legal%2Fopenadlc%2F[a-z]+)%3Apull&service=ghcr\.io$/.exec(url);
      if (token) return { status: 200, body: Buffer.from(JSON.stringify({ token: `anonymous-${decodeURIComponent(token[1]!)}` })) };
      const wanted = /^https:\/\/ghcr\.io\/v2\/620legal\/openadlc\/(service|console)\/manifests\/(v[0-9.]+)$/.exec(url);
      if (!wanted || headers.authorization !== `Bearer anonymous-620legal/openadlc/${wanted[1]}`) return { status: 401, body: Buffer.from('{}') };
      if (!published(wanted[2]!) || world.hidden?.includes(`${wanted[2]}/${wanted[1]}`)) return { status: 404, body: Buffer.from('{}') };
      return { status: 200, body: manifest(wanted[2]!, wanted[1]!) };
    },
  };
  const mirrored = (tag: string, image: 'service' | 'console') => `${MIRROR}/620legal/openadlc/${image}@${digest(tag, image)}`;
  return { runners, gh, verified, got, digest, mirrored };
}

describe('a release image as a cloud install pulls it', () => {
  it('is the image on ghcr.io, through the install’s mirror, by digest', () => {
    const mirror = releaseMirror('us-central1', 'example-project', 'openadlc');
    expect(mirror).toBe(MIRROR);
    expect(mirrorImage(mirror, REPO, 'service', sha('a'))).toBe(`${MIRROR}/620legal/openadlc/service@${sha('a')}`);
  });

  it('is told apart from any other image the bridge could run', () => {
    expect(mirrorDigest(`${MIRROR}/620legal/openadlc/service@${sha('a')}`, MIRROR, REPO, 'service')).toBe(sha('a'));
    for (const other of [
      `${MIRROR}/620legal/openadlc/console@${sha('a')}`,
      `${MIRROR}/620legal/openadlc/service:v0.2.0`,
      `ghcr.io/620legal/openadlc/service@${sha('a')}`,
      `us-central1-docker.pkg.dev/example-project/openadlc/bridge:latest`,
      `${MIRROR}/620legal/openadlc/service@sha256:${'a'.repeat(63)}`,
    ]) {
      expect(mirrorDigest(other, MIRROR, REPO, 'service'), other).toBeNull();
    }
  });
});

describe('the digest a release tag names', () => {
  it('is the hash of the manifest ghcr.io serves under an anonymous token, with no sign-in', async () => {
    const { runners, got, digest } = releaseWorld({ releases: [{ tag: 'v0.2.0' }] });
    expect(await releaseDigest(REPO, 'console', 'v0.2.0', runners.get)).toBe(digest('v0.2.0', 'console'));
    expect(got.map((call) => call.url)).toEqual([
      'https://ghcr.io/token?scope=repository%3A620legal%2Fopenadlc%2Fconsole%3Apull&service=ghcr.io',
      'https://ghcr.io/v2/620legal/openadlc/console/manifests/v0.2.0',
    ]);
    // Nothing of this machine's goes with it: only the token ghcr.io handed out.
    expect(got[0]!.headers).toEqual({});
    expect(Object.keys(got[1]!.headers).sort()).toEqual(['accept', 'authorization']);
    for (const type of [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.docker.distribution.manifest.v2+json',
    ]) {
      expect(got[1]!.headers.accept).toContain(type);
    }
  });

  it('is refused, saying the packages may not be public yet, when ghcr.io will not show it', async () => {
    const { runners } = releaseWorld({ releases: [{ tag: 'v0.2.0' }], hidden: ['v0.2.0/console'] });
    await expect(releaseDigest(REPO, 'console', 'v0.2.0', runners.get)).rejects.toThrow(/ghcr\.io\/620legal\/openadlc\/console:v0\.2\.0[\s\S]*public/);
  });
});

describe('the release images configure takes', () => {
  it('are the newest release whose images’ attestations check out, as mirror digests', async () => {
    const { runners, verified, mirrored, digest } = releaseWorld({
      releases: [
        { tag: 'v0.1.0' },
        { tag: 'v0.4.0', assets: ['SHA256SUMS'] },
        { tag: 'v0.3.0', draft: true },
        { tag: 'v0.2.1', immutable: false },
        { tag: 'v0.2.0' },
      ],
      refused: { 'v0.2.0/console': 'verifying with issuer "sigstore.dev": no matching attestation' },
    });
    const chosen = await newestReleaseImages(REPO, MIRROR, runners);
    expect(chosen.images).toEqual({
      tag: 'v0.1.0',
      commit: commitOf('v0.1.0'),
      service: mirrored('v0.1.0', 'service'),
      console: mirrored('v0.1.0', 'console'),
    });
    // v0.2.0 was tried first and passed over for its console image, and said.
    expect('passedOver' in chosen && chosen.passedOver.join('\n')).toMatch(/v0\.2\.0[\s\S]*console[\s\S]*no matching attestation/);
    // Each image was checked with the contract's arguments, against the API's bundles, and --format json.
    expect(verified.map((args) => args[2])).toContain(`oci://ghcr.io/620legal/openadlc/console@${digest('v0.1.0', 'console')}`);
    for (const args of verified) expect(args.slice(-2)).toEqual(['--format', 'json']);
  });

  it('read the attestations from GitHub’s API with no sign-in, and leave no bundle file behind', async () => {
    const { runners, got, verified } = releaseWorld({ releases: [{ tag: 'v0.2.0' }] });
    const checked = await checkedReleaseImages(REPO, 'v0.2.0', MIRROR, runners);
    expect(checked.ok).toBe(true);
    const asked = got.filter((call) => call.url.startsWith('https://api.github.com/'));
    expect(asked).toHaveLength(2);
    for (const call of asked) expect(Object.keys(call.headers).map((name) => name.toLowerCase())).not.toContain('authorization');
    for (const args of verified) expect(existsSync(args[args.indexOf('--bundle') + 1]!)).toBe(false);
  });

  it('refuses an image GitHub has no attestation for', async () => {
    const { runners, verified } = releaseWorld({ releases: [{ tag: 'v0.2.0' }], unattested: ['v0.2.0/service'] });
    const checked = await checkedReleaseImages(REPO, 'v0.2.0', MIRROR, runners);
    expect(!checked.ok && checked.reason).toMatch(/service[\s\S]*no attestation/);
    expect(verified).toEqual([]);
  });

  it('refuses an image whose attestation came from a run the tag’s push did not start', async () => {
    const { runners } = releaseWorld({ releases: [{ tag: 'v0.2.0' }], dispatched: ['v0.2.0/console'] });
    const checked = await checkedReleaseImages(REPO, 'v0.2.0', MIRROR, runners);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.reason).toMatch(/console[\s\S]*workflow_dispatch/);
  });

  it('are none, with every reason, when no release checks out', async () => {
    const { runners } = releaseWorld({ releases: [{ tag: 'v0.2.0' }], hidden: ['v0.2.0/service'] });
    const chosen = await newestReleaseImages(REPO, MIRROR, runners);
    expect(chosen.images).toBeNull();
    expect('reasons' in chosen && chosen.reasons.join('\n')).toMatch(/v0\.2\.0[\s\S]*public/);
    const none = await newestReleaseImages(REPO, MIRROR, releaseWorld({ releases: [{ tag: 'v0.2.0', immutable: false }] }).runners);
    expect('reasons' in none && none.reasons.join('\n')).toMatch(/v0\.2\.0[\s\S]*immutable/);
  });

  it('write the release’s service image for the bridge and for hostd, and its console image', async () => {
    const { runners, mirrored } = releaseWorld({ releases: [{ tag: 'v0.2.0' }] });
    const chosen = await configuredImages({ build: false, region: 'us-central1', projectId: 'example-project', prefix: 'openadlc', repo: REPO }, runners);
    expect(chosen.images).toEqual({
      bridgeImage: mirrored('v0.2.0', 'service'),
      hostdImage: mirrored('v0.2.0', 'service'),
      consoleImage: mirrored('v0.2.0', 'console'),
      // A release holds no bot image (it has Claude Code in it): the install
      // builds its own, under the name install.sh's Cloud Build pushes.
      botImage: cloudBuildImages('us-central1', 'example-project').botImage,
    });
    expect('said' in chosen && chosen.said.join('\n')).toContain('Claude Code');
  });

  it('keep the bot image an install already has, whatever else they take', async () => {
    const { runners, mirrored } = releaseWorld({ releases: [{ tag: 'v0.2.0' }] });
    const existing = { bot_image: 'europe-docker.pkg.dev/p/openadlc/bot:2026-09-21' };
    const chosen = await configuredImages({ build: false, existing, region: 'us-central1', projectId: 'example-project', prefix: 'openadlc', repo: REPO }, runners);
    expect(chosen.images).toEqual({
      bridgeImage: mirrored('v0.2.0', 'service'),
      hostdImage: mirrored('v0.2.0', 'service'),
      consoleImage: mirrored('v0.2.0', 'console'),
      botImage: 'europe-docker.pkg.dev/p/openadlc/bot:2026-09-21',
    });
  });

  it('are the install’s own registry’s with --build, as install.sh --build pushes them, asking GitHub nothing', async () => {
    const { runners, gh } = releaseWorld({ releases: [{ tag: 'v0.2.0' }] });
    const chosen = await configuredImages({ build: true, region: 'us-central1', projectId: 'example-project', prefix: 'openadlc', repo: REPO }, runners);
    expect(chosen.images).toEqual(cloudBuildImages('us-central1', 'example-project'));
    expect(cloudBuildImages('us-central1', 'example-project')).toEqual({
      bridgeImage: 'us-central1-docker.pkg.dev/example-project/openadlc/bridge:latest',
      hostdImage: 'us-central1-docker.pkg.dev/example-project/openadlc/hostd:latest',
      consoleImage: 'us-central1-docker.pkg.dev/example-project/openadlc/console:latest',
      botImage: 'us-central1-docker.pkg.dev/example-project/openadlc/bot:latest',
    });
    expect(gh).toEqual([]);
  });

  it.each([false, true])('are the ones an install already has, with --build %s too, which only an update moves', async (build) => {
    const { runners, gh } = releaseWorld({ releases: [{ tag: 'v0.2.0' }] });
    const existing = { bridge_image: 'a', console_image: 'b', hostd_image: 'c', bot_image: 'd' };
    const chosen = await configuredImages({ build, existing, region: 'us-central1', projectId: 'example-project', prefix: 'openadlc', repo: REPO }, runners);
    expect(chosen.images).toEqual({ bridgeImage: 'a', consoleImage: 'b', hostdImage: 'c', botImage: 'd' });
    expect(gh).toEqual([]);
  });
});

describe('the release an update takes', () => {
  const published = (tag: string, extra: { immutable?: boolean; assets?: string[] } = {}) => ({
    tag,
    draft: false,
    prerelease: false,
    publishedAt: '2026-10-01T00:00:00Z',
    assets: extra.assets ?? Object.values(releaseAssets(tag)),
    immutable: extra.immutable ?? true,
  });
  const takeable = ['v0.4.0', 'v0.3.0', 'v0.2.0', 'v0.1.0'].map((tag) => published(tag));

  it('is the next one after the release the install runs, never a later one', () => {
    expect(chooseUpdate('v0.2.0', takeable)).toEqual({ take: 'v0.3.0', skips: [] });
  });

  it('is none when the install runs the newest', () => {
    expect(chooseUpdate('v0.4.0', takeable)).toMatchObject({ code: 0, stop: expect.stringContaining('newest') });
  });

  it('is the one --release names, saying which it skips', () => {
    expect(chooseUpdate('v0.1.0', takeable, 'v0.4.0')).toEqual({ take: 'v0.4.0', skips: ['v0.2.0', 'v0.3.0'] });
    // The same release again puts each part not on it back on it.
    expect(chooseUpdate('v0.2.0', takeable, 'v0.2.0')).toEqual({ take: 'v0.2.0', skips: [] });
  });

  it('never goes back, since migrations only go forward', () => {
    const back = chooseUpdate('v0.3.0', takeable, 'v0.2.0');
    expect(back).toMatchObject({ code: 1 });
    expect('stop' in back && back.stop).toMatch(/forward/);
  });

  it('needs --release when the install runs no release’s images, and says why', () => {
    const unknown = chooseUpdate(null, takeable);
    expect(unknown).toMatchObject({ code: 1 });
    expect('stop' in unknown && unknown.stop).toContain('--release');
    expect(chooseUpdate(null, takeable, 'v0.3.0')).toEqual({ take: 'v0.3.0', skips: [] });
  });

  it('refuses a --release that is no version tag, or no release it can take', () => {
    expect(chooseUpdate('v0.1.0', takeable, 'latest')).toMatchObject({ code: 2 });
    expect(chooseUpdate('v0.1.0', takeable, '')).toMatchObject({ code: 2 });
    expect(chooseUpdate('v0.1.0', takeable, 'v0.9.0')).toMatchObject({ code: 1 });
  });

  it('stops at a next release it cannot take, as the bridge does, rather than take the one after it', () => {
    for (const next of [published('v0.2.0', { immutable: false }), published('v0.2.0', { assets: [] })]) {
      const releases = [published('v0.3.0'), next, published('v0.1.0')];
      const choice = chooseUpdate('v0.1.0', releases);
      expect(choice).toMatchObject({ code: 1 });
      expect('stop' in choice && choice.stop).toMatch(/^the next release, v0\.2\.0, is .*so it stays on v0\.1\.0 and takes no later one: roll it past v0\.2\.0 by hand with openadlc cloud update --release <tag>/);
      // Named, a later one is still taken, saying what it skips.
      expect(chooseUpdate('v0.1.0', releases, 'v0.3.0')).toEqual({ take: 'v0.3.0', skips: ['v0.2.0'] });
    }
    // A draft is no release at all, and is not waited for.
    expect(chooseUpdate('v0.1.0', [published('v0.3.0'), { ...published('v0.2.0'), draft: true }, published('v0.1.0')])).toEqual({ take: 'v0.3.0', skips: [] });
  });
});

describe('openadlc cloud update', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const settings = { project_id: 'example-project', region: 'us-central1', zone: 'us-central1-b', name_prefix: 'openadlc', bridge_image: 'old-bridge', console_image: 'old-console', hostd_image: 'old-hostd', bot_image: 'bot' };
  const hostCheck = 'test -x /etc/fleet/hostd-image.sh';

  /** The install, stood in for: the bridge's ready revision runs `running`, and each roll exits as `codes` says. */
  function install(
    world: World,
    running: string,
    options: {
      codes?: Partial<Record<'console' | 'host' | 'bridge' | 'check', number>>;
      confirm?: boolean;
      mirror?: boolean;
      saved?: number;
      /** What the console's serving revision runs, and what hostd last started on; unreadable when absent. */
      consoleOn?: string;
      hostStarted?: string;
    } = {},
  ) {
    const released = releaseWorld(world);
    const ran: { step: string; command: string; args: string[] }[] = [];
    const printed: string[] = [];
    const saved: Record<string, unknown>[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void printed.push(String(line ?? '')));
    const runners: UpdateRunners = {
      ...released.runners,
      gcloud: async (args) => {
        const where = ['--region', 'us-central1', '--project', 'example-project'];
        if (JSON.stringify(args) === JSON.stringify(['run', 'services', 'describe', 'openadlc-bridge', ...where, '--format', 'value(status.latestReadyRevisionName)'])) {
          return { code: 0, stdout: 'openadlc-bridge-00007-abc\n', stderr: '' };
        }
        if (JSON.stringify(args) === JSON.stringify(['run', 'revisions', 'describe', 'openadlc-bridge-00007-abc', ...where, '--format', 'value(spec.containers[0].image)'])) {
          return { code: 0, stdout: `${running}\n`, stderr: '' };
        }
        if (options.consoleOn && JSON.stringify(args) === JSON.stringify(['run', 'services', 'describe', 'openadlc-console', ...where, '--format', 'value(status.latestReadyRevisionName)'])) {
          return { code: 0, stdout: 'openadlc-console-00003-xyz\n', stderr: '' };
        }
        if (options.consoleOn && JSON.stringify(args) === JSON.stringify(['run', 'revisions', 'describe', 'openadlc-console-00003-xyz', ...where, '--format', 'value(spec.containers[0].image)'])) {
          return { code: 0, stdout: `${options.consoleOn}\n`, stderr: '' };
        }
        if (
          options.hostStarted &&
          JSON.stringify(args) ===
            JSON.stringify(['compute', 'ssh', 'openadlc-host-1', '--zone', 'us-central1-b', '--project', 'example-project', '--tunnel-through-iap', '--quiet', '--', 'cat /var/lib/fleet/hostd-image.started'])
        ) {
          return { code: 0, stdout: `${options.hostStarted}\n`, stderr: '' };
        }
        if (JSON.stringify(args) === JSON.stringify(['artifacts', 'repositories', 'describe', 'openadlc-ghcr', '--location', 'us-central1', '--project', 'example-project', '--format', 'value(name)'])) {
          return options.mirror === false ? { code: 1, stdout: '', stderr: 'NOT_FOUND: Requested entity was not found.' } : { code: 0, stdout: 'projects/example-project/locations/us-central1/repositories/openadlc-ghcr\n', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: `gcloud ${args.join(' ')}: not stood in for` };
      },
      run: async (command, args) => {
        const step = args.at(-1) === hostCheck ? 'check' : args[0] === 'compute' ? 'host' : args[3] === 'openadlc-console' ? 'console' : args[3] === 'openadlc-bridge' ? 'bridge' : 'other';
        ran.push({ step, command, args });
        return options.codes?.[step as 'console'] ?? 0;
      },
      confirm: async () => options.confirm ?? true,
      saveSettings: async (vars) => {
        saved.push(vars);
        return options.saved ?? 0;
      },
    };
    return { ...released, runners, ran, printed, saved };
  }

  const world: World = { releases: [{ tag: 'v0.1.0' }, { tag: 'v0.2.0' }, { tag: 'v0.3.0' }] };
  const v010 = () => releaseWorld(world).mirrored('v0.1.0', 'service');

  it('checks the mirror and the host’s unit, then rolls the console, then hostd, then the bridge, last; never the bot image', async () => {
    const { runners, ran, printed, mirrored } = install(world, v010());
    expect(await updateCommand(settings, undefined, runners)).toBe(0);
    expect(ran.map((one) => one.step)).toEqual(['check', 'console', 'host', 'bridge']);
    expect(ran[0]!.args).toEqual(['compute', 'ssh', 'openadlc-host-1', '--zone', 'us-central1-b', '--project', 'example-project', '--tunnel-through-iap', '--', hostCheck]);
    const where = ['--region', 'us-central1', '--project', 'example-project', '--quiet'];
    expect(ran[1]).toEqual({ step: 'console', command: 'gcloud', args: ['run', 'services', 'update', 'openadlc-console', '--image', mirrored('v0.2.0', 'console'), ...where] });
    expect(ran[3]).toEqual({ step: 'bridge', command: 'gcloud', args: ['run', 'services', 'update', 'openadlc-bridge', '--image', mirrored('v0.2.0', 'service'), ...where] });
    const host = ran[2]!.args;
    expect(host.slice(0, -1)).toEqual(['compute', 'ssh', 'openadlc-host-1', '--zone', 'us-central1-b', '--project', 'example-project', '--tunnel-through-iap', '--']);
    const remote = host.at(-1) ?? '';
    expect(remote).toMatch(/^sudo sh -c "[^"$`\\]*"$/);
    const service = mirrored('v0.2.0', 'service');
    // Pulled first, so a pull that fails changes nothing on the host.
    const pull = remote.indexOf(`HOME=/var/lib/fleet/home docker pull ${service}`);
    expect(pull).toBeGreaterThan(remote.indexOf('set -e'));
    expect(pull).toBeLessThan(remote.indexOf(`echo ${service} > /var/lib/fleet/hostd-image.next`));
    expect(remote).toContain('mv -f /var/lib/fleet/hostd-image.next /var/lib/fleet/hostd-image');
    // On disk before hostd restarts onto it, and checked by what started after.
    expect(remote.indexOf('sync')).toBeLessThan(remote.indexOf('systemctl restart fleet-hostd'));
    expect(remote.indexOf('systemctl restart fleet-hostd')).toBeLessThan(remote.indexOf(`grep -qxF ${service} /var/lib/fleet/hostd-image.started`));
    // The bot image is the host's own, which its weekly engine update moves.
    expect(ran.flatMap((one) => one.args).join(' ')).not.toContain('/bot');
    const said = printed.join('\n');
    expect(said).toContain('v0.1.0');
    expect(said).toMatch(/runs v0\.2\.0/);
    // One at a time: the release after it is for the next run.
    expect(said).toContain('v0.3.0');
  });

  it('writes what it rolled into the settings, and saves them to the bucket, so an apply or a new service takes the release', async () => {
    const { runners, saved, mirrored } = install(world, v010());
    expect(await updateCommand(settings, undefined, runners)).toBe(0);
    expect(saved).toEqual([
      { ...settings, console_image: mirrored('v0.2.0', 'console'), hostd_image: mirrored('v0.2.0', 'service'), bridge_image: mirrored('v0.2.0', 'service') },
    ]);
  });

  it('refuses to skip a release whose images do not check out, and rolls nothing', async () => {
    const { runners, ran, printed, saved } = install({ ...world, refused: { 'v0.2.0/console': 'no matching attestation' } }, v010());
    expect(await updateCommand(settings, undefined, runners)).toBe(1);
    expect(ran).toEqual([]);
    expect(saved).toEqual([]);
    const said = printed.join('\n');
    expect(said).toContain('v0.2.0');
    expect(said).toContain('no matching attestation');
    expect(said).toMatch(/migrat/);
    expect(said).toContain('--release');
  });

  it('says what is left, with the exact commands, when a roll stops partway, and saves only what rolled', async () => {
    const { runners, ran, printed, saved, mirrored } = install(world, v010(), { codes: { host: 1 } });
    expect(await updateCommand(settings, undefined, runners)).toBe(1);
    expect(ran.map((one) => one.step)).toEqual(['check', 'console', 'host']);
    const said = printed.join('\n');
    expect(said).toMatch(/console runs v0\.2\.0/);
    expect(said).toContain(`gcloud run services update openadlc-bridge --image ${mirrored('v0.2.0', 'service')} --region us-central1 --project example-project --quiet`);
    expect(said).toContain("gcloud compute ssh openadlc-host-1 --zone us-central1-b --project example-project --tunnel-through-iap -- 'sudo sh -c \"");
    expect(said).toContain('journalctl -u fleet-hostd');
    expect(said).toContain('openadlc cloud update');
    expect(saved).toEqual([{ ...settings, console_image: mirrored('v0.2.0', 'console') }]);
  });

  it.each([
    ['the mirror is not there', { mirror: false }, 'openadlc cloud apply'],
    ['the host’s unit predates release images', { codes: { check: 1 } }, 'openadlc cloud apply'],
  ] as const)('rolls nothing when %s', async (_, options, said) => {
    const { runners, ran, printed, saved } = install(world, v010(), options);
    expect(await updateCommand(settings, undefined, runners)).toBe(1);
    expect(ran.filter((one) => one.step !== 'check')).toEqual([]);
    expect(saved).toEqual([]);
    expect(printed.join('\n')).toContain(said);
  });

  it('changes nothing when the person does not confirm', async () => {
    const { runners, ran, saved } = install(world, v010(), { confirm: false });
    expect(await updateCommand(settings, undefined, runners)).toBe(1);
    expect(ran.map((one) => one.step)).toEqual(['check']);
    expect(saved).toEqual([]);
  });

  it('needs --release for an install whose bridge runs images it built, then rolls the one named', async () => {
    const built = 'us-central1-docker.pkg.dev/example-project/openadlc/bridge:latest';
    const refused = install(world, built);
    expect(await updateCommand(settings, undefined, refused.runners)).toBe(1);
    expect(refused.ran).toEqual([]);
    expect(refused.printed.join('\n')).toContain('--release');
    vi.restoreAllMocks();

    const named = install(world, built);
    expect(await updateCommand(settings, 'v0.1.0', named.runners)).toBe(0);
    expect(named.ran.map((one) => one.step)).toEqual(['check', 'console', 'host', 'bridge']);
  });

  it('stops with nothing rolled, --release or not, when it cannot tell which release the bridge runs', async () => {
    // ghcr.io not answering is not "no release": with --release it would
    // have let an older release, or a skip, through unchecked.
    for (const wanted of [undefined, 'v0.1.0']) {
      const offline = install({ ...world, offline: true }, releaseWorld(world).mirrored('v0.2.0', 'service'));
      expect(await updateCommand(settings, wanted, offline.runners)).toBe(1);
      expect(offline.ran).toEqual([]);
      expect(offline.printed.join('\n')).toContain('could not reach ghcr.io');
      vi.restoreAllMocks();
    }
    // Nor is a release image no takeable release has.
    const stray = install(world, `${MIRROR}/620legal/openadlc/service@${sha('e')}`);
    expect(await updateCommand(settings, 'v0.1.0', stray.runners)).toBe(1);
    expect(stray.ran).toEqual([]);
    expect(stray.printed.join('\n')).toMatch(/goes back|skips/);
  });

  it('finds the release the install runs a page or more down the list', async () => {
    // v0.3.0 and v0.2.0, then 98 drafts: v0.1.0 is the first of page 2.
    const paged: World = { releases: [{ tag: 'v0.3.0' }, { tag: 'v0.2.0' }, ...Array.from({ length: 98 }, (_, n) => ({ tag: `v9.${n}.0`, draft: true })), { tag: 'v0.1.0' }] };
    const { runners, ran, printed, gh } = install(paged, releaseWorld(paged).mirrored('v0.1.0', 'service'));
    expect(await updateCommand(settings, undefined, runners)).toBe(0);
    expect(printed.join('\n')).toContain('the install runs v0.1.0');
    expect(ran.map((one) => one.step)).toEqual(['check', 'console', 'host', 'bridge']);
    expect(gh.filter((args) => args[1]?.includes('/releases?')).map((args) => args[1])).toEqual([`repos/${REPO}/releases?per_page=100`, `repos/${REPO}/releases?per_page=100&page=2`]);
  });

  it('does nothing on the newest release', async () => {
    const { runners, ran, printed } = install(world, releaseWorld(world).mirrored('v0.3.0', 'service'));
    expect(await updateCommand(settings, undefined, runners)).toBe(0);
    expect(ran).toEqual([]);
    expect(printed.join('\n')).toContain('newest');
  });

  it('rolls only what is not on the release already, so running it again after a stop restarts hostd only when it must', async () => {
    const at = releaseWorld(world).mirrored;
    // Stopped at the host: the console is on v0.2.0, hostd and the bridge are not.
    const host = install(world, v010(), { consoleOn: at('v0.2.0', 'console'), hostStarted: at('v0.1.0', 'service') });
    expect(await updateCommand(settings, 'v0.2.0', host.runners)).toBe(0);
    expect(host.ran.map((one) => one.step)).toEqual(['check', 'host', 'bridge']);
    expect(host.printed.join('\n')).toContain('the console: already on v0.2.0, left as it is');
    expect(host.saved).toEqual([{ ...settings, console_image: at('v0.2.0', 'console'), hostd_image: at('v0.2.0', 'service'), bridge_image: at('v0.2.0', 'service') }]);
    vi.restoreAllMocks();

    // Stopped at the bridge: hostd is left running, and its tasks with it.
    const bridge = install(world, v010(), { consoleOn: at('v0.2.0', 'console'), hostStarted: at('v0.2.0', 'service') });
    expect(await updateCommand(settings, 'v0.2.0', bridge.runners)).toBe(0);
    expect(bridge.ran.map((one) => one.step)).toEqual(['check', 'bridge']);
    expect(bridge.printed.join('\n')).not.toContain('restarting hostd ends the tasks');
  });

  it('names what each rolled part ran before when a roll stops, with the command that puts it back', async () => {
    const at = releaseWorld(world).mirrored;
    const built = 'us-central1-docker.pkg.dev/example-project/openadlc/hostd:latest';
    const { runners, printed } = install(world, v010(), { consoleOn: at('v0.1.0', 'console'), hostStarted: built, codes: { bridge: 1 } });
    expect(await updateCommand(settings, undefined, runners)).toBe(1);
    const said = printed.join('\n');
    expect(said).toContain(`gcloud run services update openadlc-console --image ${at('v0.1.0', 'console')} --region us-central1 --project example-project --quiet`);
    // A host that ran the module's hostd_image goes back only once both files are gone: the unit falls back to the second first.
    expect(said).toContain('sudo rm -f /var/lib/fleet/hostd-image /var/lib/fleet/hostd-image.started && sudo systemctl restart fleet-hostd');
  });

  it('says so, and fails, when the rolled settings could not be saved', async () => {
    const { runners, printed } = install(world, v010(), { saved: 1 });
    expect(await updateCommand(settings, undefined, runners)).toBe(1);
    expect(printed.join('\n')).toContain('openadlc cloud push');
  });
});

describe('the images in use, read into the settings before a plan or an apply', () => {
  const release = (image: 'service' | 'console', c: string) => `${MIRROR}/620legal/openadlc/${image}@${sha(c)}`;
  const settings = { project_id: 'example-project', region: 'us-central1', zone: 'us-central1-b', name_prefix: 'openadlc', console_image: release('console', '1'), bridge_image: release('service', '1'), hostd_image: release('service', '1') };

  function gcloud(on: { console: string; bridge: string; host?: string | null }) {
    const asked: string[][] = [];
    const run = async (args: string[]) => {
      asked.push(args);
      const where = ['--region', 'us-central1', '--project', 'example-project'];
      for (const part of ['console', 'bridge'] as const) {
        if (JSON.stringify(args) === JSON.stringify(['run', 'services', 'describe', `openadlc-${part}`, ...where, '--format', 'value(status.latestReadyRevisionName)'])) return { code: 0, stdout: `openadlc-${part}-00009-abc\n`, stderr: '' };
        if (JSON.stringify(args) === JSON.stringify(['run', 'revisions', 'describe', `openadlc-${part}-00009-abc`, ...where, '--format', 'value(spec.containers[0].image)'])) return { code: 0, stdout: `${on[part]}\n`, stderr: '' };
      }
      if (args[0] === 'compute' && args[1] === 'ssh') return on.host ? { code: 0, stdout: `${on.host}\n`, stderr: '' } : { code: 255, stdout: '', stderr: 'ERROR: (gcloud.compute.ssh) could not connect' };
      return { code: 1, stdout: '', stderr: 'not stood in for' };
    };
    return { run, asked };
  }

  it('takes what a self-update rolled, from the serving revisions and the image hostd last started on', async () => {
    const { run } = gcloud({ console: release('console', '2'), bridge: release('service', '2'), host: release('service', '2') });
    const read = await imagesInUse(settings, run);
    expect(read.vars).toEqual({ ...settings, console_image: release('console', '2'), bridge_image: release('service', '2'), hostd_image: release('service', '2') });
    expect(read.changed.map((one) => one.setting)).toEqual(['console_image', 'bridge_image', 'hostd_image']);
  });

  it('asks the host nothing when the services show no roll the settings have not seen', async () => {
    const { run, asked } = gcloud({ console: release('console', '1'), bridge: release('service', '1') });
    expect(await imagesInUse(settings, run)).toEqual({ vars: settings, changed: [], notes: [] });
    expect(asked.filter((args) => args[1] === 'ssh')).toEqual([]);
  });

  it('keeps hostd_image, saying so, when the host cannot be read; and writes nothing that is no release image by digest', async () => {
    const unread = await imagesInUse(settings, gcloud({ console: release('console', '2'), bridge: release('service', '2'), host: null }).run);
    expect(unread.vars.hostd_image).toBe(settings.hostd_image);
    expect(unread.notes.join(' ')).toMatch(/hostd_image stays .*a host made again would start on that/);
    const built = await imagesInUse(settings, gcloud({ console: 'us-central1-docker.pkg.dev/example-project/openadlc/console:latest', bridge: 'us-central1-docker.pkg.dev/example-project/openadlc/bridge:latest' }).run);
    expect(built.changed).toEqual([]);
  });
});

describe('the way back onto what a part ran', () => {
  const target = { projectId: 'example-project', region: 'us-central1', zone: 'us-central1-b', prefix: 'openadlc', repo: REPO, mirror: MIRROR };
  it('writes a release image into the host’s file, and removes both files for anything else', () => {
    const release = `${MIRROR}/620legal/openadlc/service@${sha('a')}`;
    expect(goBackCommand(target, 'host', release)).toBe(
      `gcloud compute ssh openadlc-host-1 --zone us-central1-b --project example-project --tunnel-through-iap -- 'sudo sh -c "echo ${release} > /var/lib/fleet/hostd-image" && sudo systemctl restart fleet-hostd'`,
    );
    expect(goBackCommand(target, 'host', 'us-central1-docker.pkg.dev/example-project/openadlc/hostd:latest')).toContain('sudo rm -f /var/lib/fleet/hostd-image /var/lib/fleet/hostd-image.started');
    expect(goBackCommand(target, 'bridge', release)).toBe(`gcloud run services update openadlc-bridge --image ${release} --region us-central1 --project example-project --quiet`);
  });
});

describe('the commands an update rolls with', () => {
  it('never put a reference that is not a release image by digest on a command line', () => {
    const target = { projectId: 'example-project', region: 'us-central1', zone: 'us-central1-b', prefix: 'openadlc', repo: REPO, mirror: MIRROR };
    const good = { tag: 'v0.2.0', commit: commitOf('v0.2.0'), service: `${MIRROR}/620legal/openadlc/service@${sha('a')}`, console: `${MIRROR}/620legal/openadlc/console@${sha('b')}` };
    expect(rollSteps(target, good).map((step) => step.name)).toEqual(['console', 'host', 'bridge']);
    expect(() => rollSteps(target, { ...good, service: `${MIRROR}/620legal/openadlc/service@${sha('a')}; reboot` })).toThrow();
    expect(() => rollSteps(target, { ...good, console: `${MIRROR}/620legal/openadlc/service@${sha('b')}` })).toThrow();
  });
});
