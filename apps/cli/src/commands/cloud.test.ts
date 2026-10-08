import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configureDefaults,
  afterTerraform,
  applyShouldResetHost,
  askRequired,
  backendArgs,
  canonicalRepository,
  configuredVars,
  consoleUsers,
  DEFAULT_DEPLOYER_WORKFLOW,
  hostNeedsReset,
  hostResetArgs,
  LEGACY_NAME_PREFIX,
  NAME_PREFIX,
  noAdminWarning,
  pinNamePrefix,
  postApplySteps,
  remoteTfVars,
  terraformProblem,
  tfVars,
  writeCloudFiles,
  type CloudConfig,
} from './cloud.js';

const cloud: CloudConfig = {
  provider: 'gcp',
  projectId: 'example-project',
  region: 'us-central1',
  zone: 'us-central1-a',
  organization: 'example-org',
  githubClientId: 'Iv1.example',
  humans: ['ada'],
  consoleDomain: 'fleetadlc.example.com',
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
    const steps = postApplySteps('/home/ada/.fleetadlc/cloud.tfvars.json').join('\n');
    expect(steps).toContain('webhook_url');
    expect(steps).toContain('GitHub App’s webhook');
    expect(steps).toContain('webhook_secret in /home/ada/.fleetadlc/cloud.tfvars.json');
    expect(steps).toContain('console’s webhook step');
    expect(steps).not.toMatch(/bridge_url|bridge URL|organization/i);
  });

  it('tells the operator to run nothing on the host, which has no fleetadlc', () => {
    const steps = postApplySteps('/home/ada/.fleetadlc/cloud.tfvars.json');
    for (const step of steps) {
      expect(step).not.toMatch(/fleetadlc (auth|doctor|github|restore)/);
      expect(step).not.toMatch(/on the host/i);
    }
    const text = steps.join('\n');
    expect(text).toContain('GitHub accounts step');
    expect(text).toContain('health cards');
    expect(text).toContain('webhook card');
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
    expect(backendArgs({ bucket: 'b', prefix: 'fleetadlc' })).toEqual([
      '-reconfigure',
      '-backend-config=bucket=b',
      '-backend-config=prefix=fleetadlc',
    ]);
    const backendTf = readFileSync(join(import.meta.dirname, '../../../../infra/gcp/backend.tf'), 'utf8');
    expect(backendTf).toMatch(/backend "gcs" \{\}/);
  });

  it('keeps the settings beside the state', () => {
    expect(remoteTfVars({ bucket: 'b', prefix: 'fleetadlc' })).toBe('gs://b/fleetadlc/cloud.tfvars.json');
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
  // admin_emails, and reset a pre-rename install's prefix to fleetadlc.
  const { webhookSecret: _secret, ...answers } = cloud;
  const fresh = () => 'f'.repeat(64);
  const existing = {
    ...tfVars({ ...cloud, webhookSecret: 'kept-secret' }, 47312),
    name_prefix: 'fleetadlc',
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
    const warning = noAdminWarning([], '/home/ada/.fleetadlc/cloud.tfvars.json');
    expect(warning).toContain('no admin');
    expect(warning).toContain('"admin_emails": ["you@example.com"]');
    expect(warning).toContain('/home/ada/.fleetadlc/cloud.tfvars.json');
    expect(warning).toContain('fleetadlc cloud apply');
    expect(noAdminWarning(['ada@example.com'], '/home/ada/.fleetadlc/cloud.tfvars.json')).toBeNull();
  });
});

describe('what configure writes on a machine with no install', () => {
  it('makes $FLEETADLC_HOME and writes the settings and the backend there, private', () => {
    // On a laptop that never ran a local install, the write failed with ENOENT
    // after every question was answered, and the answers were lost.
    const scratch = mkdtempSync(join(tmpdir(), 'fleetadlc-cloud-'));
    const home = join(scratch, 'not', 'yet');
    const before = process.env.FLEETADLC_HOME;
    process.env.FLEETADLC_HOME = home;
    try {
      writeCloudFiles(tfVars(cloud, 47312), { bucket: 'b', prefix: 'fleetadlc' });
      expect(JSON.parse(readFileSync(join(home, 'cloud.tfvars.json'), 'utf8'))).toMatchObject({ project_id: 'example-project' });
      expect(statSync(join(home, 'cloud.tfvars.json')).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(home, 'cloud.backend.json'), 'utf8'))).toEqual({ bucket: 'b', prefix: 'fleetadlc' });
      expect(statSync(home).mode & 0o777).toBe(0o700);
    } finally {
      if (before === undefined) delete process.env.FLEETADLC_HOME;
      else process.env.FLEETADLC_HOME = before;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a cloud configure question that needs an answer', () => {
  // The example sat in parentheses, where prompt() shows a default, and Enter
  // wrote an empty console domain into the settings.
  it('is asked again until it has one, and takes a default when there is one', async () => {
    const answers = ['', '  ', 'fleetadlc.example.com'];
    const asked: string[] = [];
    const ask = async (question: string, fallback?: string) => {
      asked.push(question);
      return answers.shift() || fallback || '';
    };
    expect(await askRequired(ask, 'the console’s domain, e.g. fleetadlc.example.com')).toBe('fleetadlc.example.com');
    expect(asked).toHaveLength(3);
    expect(await askRequired(async (_question, fallback) => fallback ?? '', 'project id', 'exampleco-fleetadlc')).toBe('exampleco-fleetadlc');
  });
});

describe('the host after an apply', () => {
  it('is reset when its cloud-init or database settings changed, since a restart runs the old prepare script', () => {
    expect(hostNeedsReset({ host: 'fleetadlc-host-1', rollout: 'a' }, 'b')).toBe(true);
  });

  it('is reset once when its state predates the value, which is the apply that turns TLS on', () => {
    expect(hostNeedsReset({ host: 'fleetadlc-host-1', rollout: null }, 'b')).toBe(true);
  });

  it('is left alone when nothing it runs on changed', () => {
    expect(hostNeedsReset({ host: 'fleetadlc-host-1', rollout: 'a' }, 'a')).toBe(false);
  });

  it('is left alone when this apply made it, because it booted on the new settings', () => {
    expect(hostNeedsReset({ host: null, rollout: null }, 'b')).toBe(false);
  });

  it('is reset when the apply failed after the rollout changed, not only when it exited 0', () => {
    // Terraform committed the new database URL and then failed on a later
    // resource. The host kept the old prepare script and lost the database.
    const before = { host: 'fleetadlc-host-1', rollout: 'a' };
    expect(applyShouldResetHost('apply', before, 'b')).toBe(true);
  });

  it('is left alone when a failed apply did not change what the host runs on', () => {
    expect(applyShouldResetHost('apply', { host: 'fleetadlc-host-1', rollout: 'a' }, 'a')).toBe(false);
  });

  it('is left alone by a plan, which does not change the host', () => {
    expect(applyShouldResetHost('plan', { host: 'fleetadlc-host-1', rollout: 'a' }, 'b')).toBe(false);
  });

  it('is reset by the apply command when Terraform exited 1 after the rollout had changed', async () => {
    const ran: string[][] = [];
    const pushed: string[] = [];
    await afterTerraform(
      'apply',
      1,
      { host: 'fleetadlc-host-1', rollout: 'a' },
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
    expect(ran).toEqual([['gcloud', ...hostResetArgs('fleetadlc-host-1', 'us-central1-b', 'example-project')]]);
    // A failed apply's settings are not the ones the next operator should find.
    expect(pushed).toEqual([]);
  });

  it('is reset by name, in its zone and project', () => {
    expect(hostResetArgs('fleetadlc-host-1', 'us-central1-a', 'example-project')).toEqual([
      'compute',
      'instances',
      'reset',
      'fleetadlc-host-1',
      '--zone',
      'us-central1-a',
      '--project',
      'example-project',
    ]);
  });
});

describe('what configure offers a new install', () => {
  it('takes the project, region and console members infra/gcp/install.sh found', () => {
    expect(
      configureDefaults({
        FLEETADLC_CLOUD_PROJECT: 'acme-openadlc',
        FLEETADLC_CLOUD_REGION: 'europe-west1',
        FLEETADLC_CLOUD_CONSOLE_MEMBERS: 'user:alex@example.com',
      }),
    ).toEqual({ projectId: 'acme-openadlc', region: 'europe-west1', consoleMembers: 'user:alex@example.com' });
  });

  it('offers nothing it was not given, so a blank does not become an answer', () => {
    expect(configureDefaults({ FLEETADLC_CLOUD_PROJECT: '  ', FLEETADLC_CLOUD_REGION: '' })).toEqual({
      projectId: undefined,
      region: undefined,
      consoleMembers: undefined,
    });
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
