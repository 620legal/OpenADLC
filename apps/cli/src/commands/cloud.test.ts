import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  defaultOperators,
  hostNeedsReset,
  hostResetArgs,
  invalidMember,
  LEGACY_NAME_PREFIX,
  memberArguments,
  membersCommand,
  type MembersRunners,
  NAME_PREFIX,
  noAdminWarning,
  normalizedMembers,
  pinNamePrefix,
  postApplySteps,
  remoteTfVars,
  settledAnswers,
  terraformProblem,
  tfVars,
  withAddedMembers,
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
