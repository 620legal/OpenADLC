import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoSetupView, outcomeCounts, saveApprovers, setUpRepository, sharedLimits, type RepoPlan, type RepoRun, repositoriesReady } from './repo-setup-step';

const TRIAGE =
  'a user-owned repository has no Triage role, so intake and the automation account hold write; OpenADLC’s own gates are what keep them from pushing';

function plan(repository: string, partial: Partial<RepoPlan> = {}): RepoPlan {
  return {
    repository,
    labels: [
      { name: 'stage:intake', action: 'create', detail: 'not there yet' },
      { name: 'stage:build', action: 'unchanged', detail: '' },
    ],
    rules: [
      { name: 'fleetadlc: main', state: 'missing', detail: 'no ruleset by this name' },
      { name: 'triage role', state: 'unsupported', detail: TRIAGE },
    ],
    templates: [{ name: 'AGENTS.md', state: 'present', detail: '' }],
    labelChanges: 1,
    ruleChanges: 1,
    canApply: true,
    detail: '2 thing(s) would change',
    ...partial,
  };
}

function render(plans: RepoPlan[], extra: { runs?: Record<string, RepoRun>; running?: boolean } = {}): string {
  return renderToStaticMarkup(
    <RepoSetupView
      plans={plans}
      runs={extra.runs ?? {}}
      running={extra.running ?? false}
      busy={null}
      done={{}}
      error={null}
      onSetUpAll={() => undefined}
      onApply={() => undefined}
      onApprovers={async () => undefined}
      onProduction={async () => undefined}
    />,
  ).replace(/<!-- -->/g, '');
}

describe('the last step', () => {
  const plans = [plan('acme/one'), plan('acme/two'), plan('acme/three')];

  it('says what it does before anything else, and offers one button for every repository', () => {
    const html = render(plans);
    expect(html).toContain('Nothing happens until you press the button');
    expect(html).toContain('committed straight to the default branch');
    expect(html).toContain('the 2 labels the board uses');
    expect(html).toContain('Set up all 3 repositories</button>');
    expect(html.indexOf('Nothing happens')).toBeLessThan(html.indexOf('Set up all'));
  });

  it('says a limit every repository shares once, not once per repository', () => {
    const html = render(plans);
    expect(html.split('no Triage role').length - 1).toBe(1);
    // Every repository has it, so none is named beside it.
    expect(html).not.toContain('(acme/one, acme/two, acme/three)');
  });

  it('names the repositories a limit applies to when it is not all of them', () => {
    const html = render([plan('acme/one'), plan('acme/two', { rules: [] })]);
    // Counted, with the names behind the expand.
    expect(html).toContain('1 of 2 repositories');
    expect(html).toMatch(/<summary[^>]*>1 of 2 repositories<\/summary>[\s\S]*acme\/one/);
  });

  it('folds each repository’s listing, closed, and keeps its own two buttons inside', () => {
    const html = render(plans);
    // One per repository, the plan limits, and their list of repositories.
    expect(html.match(/<details/g)).toHaveLength(plans.length + 2);
    expect(html).not.toContain('<details open');
    expect(html).toContain('write 1 label only');
    expect(html).toContain('apply 1 change only');
  });

  it('shows each repository’s progress in its row, with the reason when one needs attention', () => {
    const html = render(plans, {
      running: true,
      runs: {
        'acme/one': { state: 'ok', written: 2 },
        'acme/two': { state: 'attention', written: 1, reasons: ['fleetadlc: main — Upgrade to GitHub Pro'] },
        'acme/three': { state: 'running' },
      },
    });
    expect(html).toContain('Setting up… 2 of 3');
    expect(html).toContain('>✓ ready</span>');
    expect(html).toContain('needs attention');
    expect(html).toContain('fleetadlc: main — Upgrade to GitHub Pro');
    expect(html).toContain('setting up…');
  });

  it('says a finished repository is ready, with nothing to press and the explanation folded', () => {
    const settled = plan('acme/one', { labelChanges: 0, ruleChanges: 0 });
    const html = render([settled]);
    expect(html).toMatch(/✓ <span[^>]*>acme\/one<\/span> is ready for the crew\./);
    expect(html).toContain('Nothing more to do here.');
    expect(html).toContain('>✓ ready</span>');
    // No button that reads as one still to press, and no “set up” to misread as one.
    expect(html).not.toContain('<button');
    expect(html).not.toContain('set up');
    expect(html).not.toContain('Nothing happens until you press the button');
    expect(html).toMatch(/<summary[^>]*>What this step put in place<\/summary>/);
  });

  it('says plan limits as something OpenADLC covers, folded, never as a failure', () => {
    const html = render([plan('acme/one', { labelChanges: 0, ruleChanges: 0 })]);
    expect(html).toContain('What GitHub doesn’t enforce on your plan');
    expect(html).toContain('OpenADLC’s own rules cover it');
    expect(html).not.toContain('Not available');
    expect(html).not.toContain('needs attention');
  });

  it('says OpenADLC holds production, not that its rules cover it, where GitHub cannot hold a production reviewer', () => {
    const refused = plan('acme/one', {
      labelChanges: 0,
      ruleChanges: 0,
      rules: [{ name: 'environment production', state: 'unsupported', detail: 'GitHub holds a required reviewer only on Enterprise.' }],
    });
    const html = render([refused]);
    expect(html).toContain('OpenADLC holds each production promote for a person in Needs you');
    expect(html).not.toContain('Nothing more to do here.');
    expect(html).not.toContain('OpenADLC’s own rules cover it');
    expect(html).toContain('and what OpenADLC holds instead');
  });

  it('says which plan holds what as the rules code does, not that rulesets need Team', () => {
    // The panel said rulesets needed Team and up, right under details
    // saying a required reviewer holds only on GitHub Enterprise.
    const html = render([plan('acme/one', { labelChanges: 0, ruleChanges: 0 })]);
    expect(html).not.toMatch(/Rulesets need Team or\s+Enterprise/i);
    expect(html).toContain('GitHub Pro');
    expect(html).toContain('a required environment reviewer needs Enterprise');
  });

  it('does not say every repository is ready while one could not be read, and names it with the bridge’s reason', () => {
    const done = plan('acme/one', { labelChanges: 0, ruleChanges: 0 });
    const unreachable = plan('acme/two', {
      canApply: false,
      labels: [],
      rules: [],
      templates: [],
      labelChanges: 0,
      ruleChanges: 0,
      detail: 'the app cannot reach this repository: GitHub answered 404',
    });
    const html = render([done, unreachable]);
    expect(html).not.toContain('are ready for the crew');
    expect(html).toMatch(/acme\/two<\/span><span[^>]*> — the app cannot reach this repository: GitHub answered 404/);
    expect(html).not.toContain('holds no app key');
  });

  it('says once that it can only report without the app key', () => {
    const noKey = { canApply: false, detail: 'OpenADLC holds no app key for this install, so it can only report' };
    const html = render([plan('acme/one', noKey), plan('acme/two', noKey)]);
    expect(html.split('holds no app key').length - 1).toBe(1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Set up all 2 repositories/);
  });
});

const PLAN_LIMIT =
  'GitHub protects a private repository’s environments only on a paid plan, and holds a required reviewer on one only on GitHub Enterprise.';
const REVIEWER_LIMIT = 'GitHub holds a required reviewer on a private repository’s environment only on GitHub Enterprise.';

/** A private repository on the free plan: neither environment protected, said the same of both. */
function freePlan(repository: string): RepoPlan {
  return plan(repository, {
    rules: [
      { name: 'environment testing', state: 'unsupported', detail: PLAN_LIMIT },
      { name: 'environment production', state: 'unsupported', detail: PLAN_LIMIT },
    ],
  });
}

describe('the limits the repositories share', () => {
  it('groups by what they say', () => {
    expect(sharedLimits([plan('acme/one'), plan('acme/two')])).toEqual([
      { names: ['triage role'], detail: TRIAGE, repositories: ['acme/one', 'acme/two'] },
    ]);
  });

  it('says a limit every repository and both environments share once, not per repository and environment', () => {
    const plans = Array.from({ length: 9 }, (_, n) => freePlan(`exampleco/repo-${n + 1}`));

    expect(sharedLimits(plans)).toEqual([
      {
        names: ['environment testing', 'environment production'],
        detail: PLAN_LIMIT,
        repositories: plans.map((one) => one.repository),
      },
    ]);

    const html = render(plans);
    expect(html).toContain('What GitHub doesn’t enforce on your plan');
    expect(html.split(PLAN_LIMIT.slice(0, 40)).length - 1).toBe(1);
    expect(html).toContain('all 9 repositories');
    // Each repository is still there, behind the expand.
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>all 9 repositories<\/summary>[\s\S]*exampleco\/repo-9/);
    // Never GitHub's path or JSON, and never the amber of something to attend to.
    expect(html).not.toMatch(/\/repos\/|documentation_url|→ 422/);
    expect(html).not.toContain('needs attention');
  });

  it('says a mixed install’s limits apart, never a rule unavailable where only another one is', () => {
    // A free-plan repository refuses both environments; a GitHub Pro one only
    // production's reviewer. One line for both would say testing is unprotected
    // on the Pro one.
    const pro = plan('exampleco/pro', {
      rules: [
        { name: 'environment testing', state: 'present', detail: '' },
        { name: 'environment production', state: 'unsupported', detail: REVIEWER_LIMIT },
      ],
    });
    const limits = sharedLimits([freePlan('exampleco/free'), pro]);

    expect(limits).toEqual([
      { names: ['environment testing', 'environment production'], detail: PLAN_LIMIT, repositories: ['exampleco/free'] },
      { names: ['environment production'], detail: REVIEWER_LIMIT, repositories: ['exampleco/pro'] },
    ]);
  });

  it('offers to check GitHub again on a repository whose environments the plan refused, and only there', () => {
    const html = render([freePlan('exampleco/free'), plan('exampleco/plain')]);
    expect(html.split('>Check GitHub again after an upgrade<').length - 1).toBe(1);
  });

  it('counts the repositories when not all of them share it', () => {
    const html = render([freePlan('exampleco/one'), plan('exampleco/two')]);
    expect(html).toContain('1 of 2 repositories');
  });
});

describe('setting up one repository', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bridge(answers: Record<'labels' | 'rules', { status: number; body: unknown }>) {
    const fetch = vi.fn(async (url: string) => {
      const what = new URL(url, 'http://console').searchParams.get('what') as 'labels' | 'rules';
      const answer = answers[what];
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('counts a row’s outcomes as written only when they were, and a refused ruleset or label as refused', () => {
    expect(
      outcomeCounts([
        { name: 'stage:intake', action: 'create', detail: 'failed: GitHub refused it' },
        { name: 'stage:build', action: 'create', detail: 'created' },
      ]),
    ).toEqual({ written: 1, refused: 1 });
    expect(
      outcomeCounts([
        { name: 'fleetadlc: main', action: 'skipped', detail: 'could not be created: 422' },
        { name: 'environment production', action: 'unsupported', detail: 'not on this plan' },
        { name: 'CODEOWNERS', action: 'created', detail: '' },
      ]),
    ).toEqual({ written: 1, refused: 1 });
  });

  it('is set up when both halves were written', async () => {
    const fetch = bridge({
      labels: { status: 200, body: { changes: [{ name: 'stage:intake', action: 'create', detail: 'not there yet' }] } },
      rules: {
        status: 200,
        body: {
          outcomes: [
            { name: 'fleetadlc: main', action: 'created', detail: '6 rule(s)' },
            { name: 'triage role', action: 'skipped', detail: TRIAGE },
          ],
        },
      },
    });
    expect(await setUpRepository(plan('acme/one'))).toEqual({ state: 'ok', written: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('needs attention, with the bridge’s own reason, when a half is refused', async () => {
    bridge({
      labels: { status: 200, body: { changes: [{ name: 'stage:intake', action: 'create', detail: 'failed: 403' }] } },
      rules: { status: 400, body: { error: 'Upgrade to GitHub Pro or make this repository public' } },
    });
    expect(await setUpRepository(plan('acme/one'))).toEqual({
      state: 'attention',
      written: 0,
      reasons: ['label stage:intake — failed: 403', 'protection — Upgrade to GitHub Pro or make this repository public'],
    });
  });

  it('is set up, not in need of attention, when the plan refuses its environments', async () => {
    // What the live install showed on every repository: the plan had not said
    // so beforehand (the environments did not exist yet), and the refusal came
    // back as the apply's outcome.
    bridge({
      labels: { status: 200, body: { changes: [] } },
      rules: {
        status: 200,
        body: {
          outcomes: [
            { name: 'environment testing', action: 'unsupported', detail: PLAN_LIMIT },
            { name: 'environment production', action: 'unsupported', detail: PLAN_LIMIT },
          ],
        },
      },
    });
    expect(await setUpRepository(plan('acme/one', { labelChanges: 0 }))).toEqual({ state: 'ok', written: 0 });
  });

  it('asks the bridge to forget the plan’s refusal when told to apply again', async () => {
    const { applyRules } = await import('./repo-setup-step');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ outcomes: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await applyRules('acme/one', { force: true });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ repo: 'acme/one', force: true });
  });

  it('does not call the bridge for a half with nothing to change', async () => {
    const fetch = bridge({
      labels: { status: 500, body: {} },
      rules: { status: 200, body: { outcomes: [] } },
    });
    await setUpRepository(plan('acme/one', { labelChanges: 0 }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('whether the step is done', () => {
  it('is done when every repository has nothing left to change, whatever the plan will not hold', () => {
    expect(repositoriesReady([freePlan('acme/one')].map((one) => ({ ...one, labelChanges: 0, ruleChanges: 0 })))).toBe(true);
  });

  it('is not done with something left to change, with only a report to go on, or with no repository', () => {
    expect(repositoriesReady([plan('acme/one')])).toBe(false);
    expect(repositoriesReady([plan('acme/one', { labelChanges: 0, ruleChanges: 0, canApply: false })])).toBe(false);
    expect(repositoriesReady([])).toBe(false);
  });
});

describe('who approves the human-review paths', () => {
  const placeholder = plan('acme/one', { labelChanges: 0, ruleChanges: 2, approvers: [], needsApprovers: true });

  it('asks, when OpenADLC cannot tell, and is not done until somebody answers', () => {
    const html = render([placeholder]);
    expect(html).toContain('Who approves changes to');
    expect(html).toContain('placeholder="your-github-username"');
    expect(html).not.toContain('is ready for the crew');
    expect(html).toContain('>needs an approver</span>');
    // Set up waits for the answer, or it writes AGENTS.md with @owner again.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Set up all 1 repository<\/button>/);
    expect(html).toContain('after saying who approves, above');
    expect(html).not.toContain('✓ ready');
    expect(repositoriesReady([placeholder])).toBe(false);
  });

  it('says what naming somebody grants, in every repository, before it is saved', () => {
    // The answer is the install's `humans`: naming a contractor to review one
    // repository's infra made them answer gates and approve production
    // deploys everywhere, and the form said only the paths.
    const html = render([placeholder]);
    expect(html).toContain('Your GitHub username, usually');
    expect(html).toContain('answer the crew’s questions and gates');
    expect(html).toContain('approve plan changes');
    expect(html).toContain('required reviewers for production deploys');
    expect(html).toContain('in every repository OpenADLC works in');
  });

  it('says the bridge’s refusal of who approves as its sentence, not the JSON it came in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nobody is called janedo on GitHub' }, null, 2), { status: 400 })));
    try {
      await expect(saveApprovers('janedo')).rejects.toThrow(/^nobody is called janedo on GitHub$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not ask once somebody is named', () => {
    const html = render([plan('acme/one', { labelChanges: 0, ruleChanges: 0, approvers: ['janedoe'], needsApprovers: false })]);
    expect(html).not.toContain('Who approves changes to');
    expect(html).toContain('is ready for the crew');
  });
});

describe('how production ships, asked for each repository', () => {
  const auto = { approval: 'auto' as const, soakMinutes: 30, reviewers: [], governedByFile: false };

  it('pre-selects automatically after testing, with a 30-minute soak', () => {
    const html = render([plan('acme/one', { production: auto, approvers: ['janedoe'] })]);
    expect(html).toContain('How production ships');
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*value="auto"/);
    expect(html).not.toMatch(/<input type="radio"[^>]*checked=""[^>]*value="reviewers"/);
    expect(html).toMatch(/aria-label="Minutes on testing before production"[^>]*value="30"/);
    // The person field is offered pre-filled from the plan's approvers, for when it is chosen.
    expect(html).toMatch(/aria-label="GitHub logins who approve production"[^>]*value="janedoe"/);
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Set up all 1 repository<\/button>/);
  });

  it('keeps Apply disabled while “after a person approves” names nobody, and says why', () => {
    const nobody = plan('acme/one', { production: { approval: 'reviewers', soakMinutes: 0, reviewers: [], governedByFile: false }, needsProductionReviewer: true });
    const html = render([nobody]);
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*value="reviewers"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Set up all 1 repository<\/button>/);
    expect(html).toContain('name at least one person who approves production');
    expect(html).toContain('needs who approves production');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });

  it('shows the file’s rule as read-only where .github/fleetadlc.yml sets it', () => {
    const html = render([plan('acme/one', { production: { ...auto, governedByFile: true } })]);
    expect(html).toContain('the file governs it');
    expect(html).not.toContain('type="radio"');
  });

  it('is ready only once production names somebody when a person approves it', () => {
    const settled = { labelChanges: 0, ruleChanges: 0 };
    expect(repositoriesReady([plan('acme/one', { ...settled, production: auto })])).toBe(true);
    expect(repositoriesReady([plan('acme/one', { ...settled, needsProductionReviewer: true })])).toBe(false);
  });
});
