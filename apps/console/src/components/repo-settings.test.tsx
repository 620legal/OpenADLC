// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repositoryRemoval } from '@/app/actions';
import type { CrewMember, RemovalChoices, RemovalPreview, RemovalReport } from '@/lib/api';

const saved = vi.hoisted(() => ({
  answer: { ok: true as boolean, shipsByMerging: undefined as boolean | null | undefined },
}));

vi.mock('@/app/actions', () => ({
  updateRepoSettings: vi.fn(async () => saved.answer),
  pauseWork: vi.fn(async () => ({ ok: true })),
  resumeWork: vi.fn(async () => ({ ok: true })),
  removeRepository: vi.fn(async () => ({ ok: true })),
  repositoryRemoval: vi.fn(async () => ({ ok: true, removal: null })),
}));
// Removing a repository refreshes the page it is on; there is no page here.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import { updateRepoSettings } from '@/app/actions';
import { REMOVAL_DEFAULTS, RemovalOutcome, RemovalReview, RepoSettings, deliveryLines, type RepoSettingsRepo } from './repo-settings';

const REPO: RepoSettingsRepo = {
  name: 'fleetadlc-testbed',
  fullName: 'janedoe/fleetadlc-testbed',
  concurrency: 1,
  owner: 'fleetadlc-atlas-janedoe',
  stageModes: {
    intake: 'autonomous',
    spec: 'conditional',
    build: 'autonomous',
    review: 'autonomous',
    merged: 'assist',
    done: 'autonomous',
  },
  specRequiredLabels: ['touches:schema', 'size:large', 'safety'],
  color: 'teal',
};

const BUILDER = {
  name: 'fleetadlc-atlas-janedoe',
  slot: 'builder',
  role: 'implement',
  authorization: 'active',
  githubLogin: 'fleetadlc-atlas-janedoe',
} as CrewMember;

function settings(repo: RepoSettingsRepo = REPO, builders = 1): string {
  return renderToStaticMarkup(
    <RepoSettings repo={repo} owner={BUILDER} builders={builders} reviewers={3} maxReviewRounds={3} />,
  ).replace(/<!-- -->/g, '');
}

/** Each stage's control: its name, its choices and the one chosen. The colour is not a stage. */
function controls(html: string): { stage: string; choices: string[]; chosen: string | null }[] {
  return [...html.matchAll(/<div role="radiogroup" aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)]
    .filter((match) => match[1] !== 'Color' && match[1] !== 'Testing deploy')
    .map((match) => {
      const buttons = [...match[2]!.matchAll(/<button[^>]*aria-checked="(true|false)"[^>]*>([^<]+)<\/button>/g)];
      return {
        stage: match[1]!,
        choices: buttons.map((button) => button[2]!),
        chosen: buttons.find((button) => button[1] === 'true')?.[2] ?? null,
      };
    });
}

describe('a repository’s settings', () => {
  it('says who builds it, and how many tasks at once with one builder', () => {
    const html = settings();
    // Under settings' Repositories heading, one of several, with its colour beside its name.
    expect(html).toMatch(/<h3[^>]*><span aria-hidden="true" class="[^"]*bg-repo-teal[^"]*"><\/span>fleetadlc-testbed<\/h3><a href="https:\/\/github.com\/janedoe\/fleetadlc-testbed"/);
    expect(html).toMatch(/<span class="font-semibold text-body">fleetadlc-atlas-janedoe<\/span><span class="text-muted"> · Builder<\/span>/);
    expect(html).toContain('Its builder runs one task at a time. Raise its tasks at once on the Crew page, or add a builder, to run two.');
    // One task at once between the builders: neither fewer nor more is on offer.
    expect(html).toMatch(/aria-label="Fewer" disabled=""/);
    expect(html).toMatch(/aria-label="More" disabled=""/);
    expect(settings(REPO, 2)).not.toMatch(/aria-label="More" disabled=""/);
  });

  it('offers a choice only on Design, and says the rest run on its own, and why', () => {
    // Ship is stored as assist here, which is on its own now: it never waited.
    expect(controls(settings())).toEqual([{ stage: 'Design', choices: ['Always', 'When it matters'], chosen: 'When it matters' }]);
    const html = settings();
    expect(html).not.toContain('Waits for you');
    expect(html.match(/>On its own</g)).toHaveLength(4);
    expect(html).toContain('Design is the one stage with a choice, because a change can skip it.');
    expect(html).toContain('What releases production is not a');
  });

  it('shows Done without a control: nothing at Done waits on anyone', () => {
    const html = settings();
    expect(html).toContain('Closes the issue once the change is live');
    expect(html).toContain('Always on its own');
    expect(html).not.toContain('aria-label="Done"');
  });

  it('says which labels earn a design pass while Design runs only when it matters', () => {
    expect(settings()).toContain(
      'Only issues labelled <span class="font-medium text-body">touches:schema</span>, <span class="font-medium text-body">size:large</span> or <span class="font-medium text-body">safety</span> get a design pass.',
    );
    expect(settings({ ...REPO, stageModes: { ...REPO.stageModes, spec: 'autonomous' } })).not.toContain('get a design pass');
  });

  it('says what Review does from the crew and the round limit', () => {
    expect(settings()).toContain('Three reviewers on different models, the lead last; stops after 3 rounds that do not agree');
  });

  it('saves as it changes, and says so', () => {
    const html = settings();
    expect(html).toContain('Changes save as you make them');
    expect(html).not.toMatch(/>save</i);
  });
});

describe('a repository’s testing deploy', () => {
  function choice(html: string): { choices: string[]; chosen: string | null } {
    const group = /<div role="radiogroup" aria-label="Testing deploy"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const buttons = [...group.matchAll(/<button[^>]*aria-checked="(true|false)"[^>]*>([^<]+)<\/button>/g)];
    return {
      choices: buttons.map((button) => button[2]!),
      chosen: buttons.find((button) => button[1] === 'true')?.[2] ?? null,
    };
  }

  it('offers Automatic, Has a testing deploy, and No testing deploy, and says what Automatic resolved to', () => {
    const html = settings({ ...REPO, shipsByMerging: true });
    expect(choice(html)).toEqual({
      choices: ['Automatic', 'Has a testing deploy', 'No testing deploy'],
      chosen: 'Automatic',
    });
    expect(html).toContain('No testing deploy for this repository. Merging ships it.');

    const has = settings({ ...REPO, testingDeploy: 'has', shipsByMerging: false });
    expect(choice(has).chosen).toBe('Has a testing deploy');
    expect(has).not.toContain('No testing deploy for this repository');

    const none = settings({ ...REPO, testingDeploy: 'none', shipsByMerging: true });
    expect(choice(none).chosen).toBe('No testing deploy');
    expect(none).not.toContain('Merging ships it.');

    expect(settings({ ...REPO, shipsByMerging: false })).toContain('This repository has a testing deploy.');
    expect(settings({ ...REPO, shipsByMerging: null })).toContain('Could not tell whether a deploy-testing workflow exists.');
    expect(settings({ ...REPO, shipsByMerging: undefined })).toContain('Could not tell whether a deploy-testing workflow exists.');
  });

  it('updates Automatic’s line from the save, not from the resolution the page opened with', async () => {
    // The page opened on No testing deploy, whose props still say merging ships it.
    // Choosing Automatic has to show what this save resolved, which is a deploy.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    saved.answer = { ok: true, shipsByMerging: false };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <RepoSettings
            repo={{ ...REPO, testingDeploy: 'none', shipsByMerging: true }}
            owner={BUILDER}
            builders={1}
            reviewers={3}
            maxReviewRounds={3}
          />,
        );
      });
      expect(container.textContent).not.toContain('Merging ships it.');
      const automatic = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Testing deploy"] [role="radio"]')].find(
        (button) => button.textContent === 'Automatic',
      );
      await act(async () => {
        automatic!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(vi.mocked(updateRepoSettings)).toHaveBeenCalledWith('fleetadlc-testbed', { testingDeploy: 'automatic' });
      expect(container.textContent).toContain('This repository has a testing deploy.');
      expect(container.textContent).not.toContain('Merging ships it.');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('a repository’s colour, in its settings', () => {
  it('is chosen from the palette, each swatch named, and the chosen one said in words', () => {
    const html = settings();
    const group = /<div role="radiogroup" aria-label="Color"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const swatches = [...group.matchAll(/aria-checked="(true|false)" aria-label="([A-Za-z]+)"/g)].map(
      (match) => `${match[2]}${match[1] === 'true' ? ' *' : ''}`,
    );
    expect(swatches).toEqual(['Blue', 'Amber', 'Pink', 'Teal *', 'Violet', 'Orange']);
    expect(html).toMatch(/<\/div><span class="[^"]*">Teal<\/span>/);
  });

  it('is said as no colour, on a bridge too old to have given it one', () => {
    const html = settings({ ...REPO, color: undefined });
    expect(html).not.toMatch(/aria-checked="true" aria-label="(Blue|Amber|Pink|Teal|Violet|Orange)"/);
    expect(html).toContain('>No color<');
    expect(html).not.toMatch(/colour/i);
  });
});

describe('removing a repository from OpenADLC, in its settings', () => {
  it('does not remove until the review is on screen, or the read has failed', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let release: (value: { ok: boolean; removal?: RemovalPreview; error?: string }) => void = () => undefined;
    vi.mocked(repositoryRemoval).mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const removeIn = (rootEl: ParentNode): HTMLButtonElement | undefined =>
      [...rootEl.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Remove from OpenADLC' && button.getAttribute('aria-haspopup') !== 'dialog');
    try {
      await act(async () => {
        root.render(<RepoSettings repo={REPO} owner={BUILDER} builders={1} reviewers={3} maxReviewRounds={3} />);
      });
      const open = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Remove from OpenADLC');
      await act(async () => {
        open!.click();
      });
      const dialog = document.body;
      expect(removeIn(dialog)?.disabled).toBe(true);
      expect(dialog.textContent).toContain('Reading what OpenADLC has going there…');
      await act(async () => {
        release({ ok: false, error: 'the bridge did not say' });
      });
      expect(removeIn(dialog)?.disabled).toBe(false);
      expect(dialog.textContent).toContain('It can still be removed.');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('does not say it can still be removed when the read was refused for who is asking', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(repositoryRemoval).mockResolvedValueOnce({ ok: false, error: 'this needs an admin', refused: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const removeIn = (rootEl: ParentNode): HTMLButtonElement | undefined =>
      [...rootEl.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Remove from OpenADLC' && button.getAttribute('aria-haspopup') !== 'dialog');
    try {
      await act(async () => {
        root.render(<RepoSettings repo={REPO} owner={BUILDER} builders={1} reviewers={3} maxReviewRounds={3} />);
      });
      const open = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Remove from OpenADLC');
      await act(async () => {
        open!.click();
      });
      const dialog = document.body;
      expect(dialog.textContent).toContain('this needs an admin');
      expect(dialog.textContent).not.toContain('It can still be removed.');
      expect(removeIn(dialog)?.disabled).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('is offered, saying what it does before anything is pressed: nothing is deleted unless the labels are chosen', () => {
    const html = settings();
    expect(html).toContain('Remove from OpenADLC');
    expect(html).toContain('after showing you what that ends.');
    expect(html).toContain('Nothing on GitHub is deleted unless you choose to delete OpenADLC’s labels.');
    // It asks first; the dialog is closed until the button is pressed.
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Remove from OpenADLC<\/button>/);
  });
});

const PREVIEW: RemovalPreview = {
  repository: 'janedoe/app',
  removedAt: null,
  tasks: [
    { id: 't1', subject: 'app#12', kind: 'intake', state: 'paused', bot: 'ottoexampleco', question: 'Which database?' },
    { id: 't2', subject: 'app#14', kind: 'implement', state: 'running', bot: 'fleetadlc-atlas-janedoe', question: null },
  ],
  questions: [{ id: 'g1', subject: 'app#12', question: 'Which database?' }],
  leases: [{ id: 'l1', issue: 14, bot: 'fleetadlc-atlas-janedoe', state: 'in_task' }],
  crew: {
    known: true,
    reason: null,
    accounts: [
      { bots: ['fleetadlc-atlas-janedoe'], login: 'fleetadlc-atlas-janedoe', state: 'collaborator' },
      { bots: ['ottoexampleco'], login: 'ottoexampleco', state: 'invited' },
    ],
  },
  labels: { known: true, reason: null, names: ['adlc:build', 'priority:p1'], maybeTheirs: ['priority:high', 'blocked'] },
  app: { allRepositories: true, settingsUrl: 'https://github.com/settings/installations/7', reason: null },
  leftAlone: 'CI, deploy workflows, environments and Actions variables are the repository’s own. OpenADLC does not touch them, and they stay as they are.',
};

function review(preview: RemovalPreview = PREVIEW, choices: RemovalChoices = REMOVAL_DEFAULTS): string {
  return renderToStaticMarkup(<RemovalReview preview={preview} choices={choices} onChange={() => undefined} />).replace(/<!-- -->/g, '');
}

describe('the review step of removing a repository', () => {
  it('lists the work it stops, with the question a paused task waits on, and the questions and claims it ends', () => {
    const html = review();
    expect(html).toContain('app#12: ottoexampleco’s intake, waiting on a question');
    expect(html).toContain('“Which database?”');
    expect(html).toContain('app#14: fleetadlc-atlas-janedoe’s implement, running');
    expect(html).toContain('Its open question is closed and leaves Needs you.');
    expect(html).toContain('The claim on #14 is released.');
  });

  it('takes the crew’s access by default, naming who, and leaves the labels unless asked', () => {
    const html = review();
    const box = (text: string) => html.match(new RegExp(`<input type="checkbox"([^>]*)/><span[^>]*><span[^>]*>${text}`))?.[1] ?? '';
    expect(box('Take the crew off its collaborators')).toContain('checked');
    expect(box('Remove OpenADLC’s labels')).not.toContain('checked');
    expect(html).toContain('Collaborators: fleetadlc-atlas-janedoe. Invited: ottoexampleco.');
    expect(html).toContain('Remove OpenADLC’s labels (those in config/labels.json)');
    expect(html).toContain('Deleting a label also takes it off every issue and pull request. It has 2: adlc:build, priority:p1.');
  });

  it('lists the labels that may be the repository’s own on their own, unticked', () => {
    const html = review();
    const box = (text: string) => html.match(new RegExp(`<input type="checkbox"([^>]*)/><span[^>]*><span[^>]*>${text}`))?.[1] ?? '';
    expect(box('Also remove the labels that may be the repository’s own')).not.toContain('checked');
    expect(html).toContain('the repository may have had them first: priority:high, blocked.');
    expect(review({ ...PREVIEW, labels: { ...PREVIEW.labels, maybeTheirs: [] } })).not.toContain('Also remove the labels');
  });

  it('says the app still reaches it when installed on all repositories, and links to where that is changed', () => {
    const html = review();
    expect(html).toContain('installed on all of janedoe’s repositories, so it still reaches this one');
    expect(html).toContain('href="https://github.com/settings/installations/7"');
  });

  it('says workflows and environments stay', () => {
    expect(review()).toContain('CI, deploy workflows, environments and Actions variables are the repository’s own.');
  });

  it('says why it cannot name the crew or the labels, rather than saying there are none', () => {
    const html = review({ ...PREVIEW, crew: { known: false, reason: 'no app key', accounts: [] }, labels: { known: false, reason: 'no app key', names: [], maybeTheirs: [] } });
    expect(html).toContain('OpenADLC could not ask GitHub who is there (no app key)');
    expect(html).toContain('OpenADLC could not read its labels (no app key).');
  });

  it('says there is nothing in flight when there is nothing', () => {
    expect(review({ ...PREVIEW, tasks: [], questions: [], leases: [] })).toContain('Nothing is running, queued or waiting there.');
  });
});

describe('what a removal could not do', () => {
  it('lists each with why and the button that finishes it, after what it did', () => {
    const report: RemovalReport = {
      options: REMOVAL_DEFAULTS,
      stopped: [{ task: 't1', subject: 'app#12', was: 'paused' }],
      questionsClosed: 1,
      leasesReleased: [14],
      collaboratorsRemoved: ['fleetadlc-atlas-janedoe'],
      invitationsCancelled: [],
      labelsRemoved: [],
      app: { allRepositories: false, settingsUrl: null, reason: null },
      notDone: [
        { step: 'task', what: 'the implement task on app#14 is still running', why: 'hostd did not stop it', action: { label: 'Remove from OpenADLC again', retry: true } },
        {
          step: 'collaborator',
          what: 'irisexampleco is still a collaborator',
          why: 'the OpenADLC GitHub App needs `Administration: read and write` on this repository',
          action: { label: 'Collaborators on GitHub', url: 'https://github.com/janedoe/app/settings/access' },
        },
      ],
    };
    const html = renderToStaticMarkup(<RemovalOutcome report={report} />).replace(/<!-- -->/g, '');
    expect(html).toContain('Done: 1 task stopped; 1 question closed; 1 claim released; fleetadlc-atlas-janedoe taken off.');
    expect(html).toContain('the implement task on app#14 is still running');
    expect(html).toContain('hostd did not stop it');
    expect(html).toContain('irisexampleco is still a collaborator');
    expect(html).toMatch(/href="https:\/\/github.com\/janedoe\/app\/settings\/access"[^>]*>Collaborators on GitHub/);
  });
});

describe('pausing work in one repository', () => {
  const render = (props: { pause?: { by: string; at: string; reason: string | null } | null; installPaused?: boolean }) =>
    renderToStaticMarkup(<RepoSettings repo={REPO} owner={BUILDER} builders={1} reviewers={3} maxReviewRounds={3} {...props} />).replace(
      /<!-- -->/g,
      '',
    );

  it('offers Pause while it runs', () => {
    const html = render({});
    expect(html).toContain('Stop new work here alone');
    expect(html).toMatch(/<button[^>]*>Pause<\/button>/);
  });

  it('says who paused it and why, and offers Resume', () => {
    const html = render({ pause: { by: 'janedoe', at: '2026-09-29T10:00:00.000Z', reason: 'a migration is running' } });
    expect(html).toContain('Paused by janedoe at 2026-09-29 10:00 UTC: a migration is running.');
    expect(html).toMatch(/<button[^>]*>Resume<\/button>/);
  });

  it('says the install’s pause holds it too', () => {
    expect(render({ installPaused: true })).toContain('Work is paused across the install, which holds this repository too');
  });

  it('takes a pause made elsewhere from the page’s next read, and offers Resume, not Pause', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const draw = (pause: { by: string; at: string; reason: string | null } | null) =>
      act(async () => root.render(<RepoSettings repo={REPO} owner={BUILDER} builders={1} reviewers={3} maxReviewRounds={3} pause={pause} />));
    const labels = () => [...container.querySelectorAll('button')].map((one) => one.textContent);

    await draw(null);
    expect(labels()).toContain('Pause');
    await draw({ by: 'oncall', at: '2026-09-29T10:00:00.000Z', reason: 'an account may be compromised' });
    expect(container.textContent).toContain('Paused by oncall at 2026-09-29 10:00 UTC: an account may be compromised.');
    expect(labels()).toContain('Resume');
    expect(labels()).not.toContain('Pause');

    act(() => root.unmount());
    container.remove();
  });
});

/**
 * How a repository ships, as the page says it: what a merge does, what holds
 * production, and where the rules came from — so a person can tell the file's
 * rules from the settings fallback, and see a file that did not parse.
 */
describe('the delivery rules, in words', () => {
  const rules = {
    testing: { on: 'merge' as const, workflow: 'deploy-testing', smoke: 'smoke-testing' },
    production: { on: 'after-testing' as const, approval: 'reviewers' as const, soakMinutes: 0, workflow: 'promote-production', rollback: 'rollback-production' },
  };

  it('says a person approves production, from the file', () => {
    const said = deliveryLines({ source: 'file', rules, testingUrl: 'https://testing.example.com', fileError: null });
    expect(said.rules.join(' ')).toContain('once a person approves it');
    // Not only the environment's reviewers: where the plan cannot hold one, OpenADLC holds it.
    expect(said.rules.join(' ')).toContain('a person releasing it from Needs you');
    expect(said.rules[0]).toContain('https://testing.example.com');
    expect(said.source).toContain('.github/fleetadlc.yml');
  });

  it('says the soak where nobody approves, and the error of a file that did not parse', () => {
    const said = deliveryLines({
      source: 'setting',
      rules: { ...rules, production: { ...rules.production, approval: 'auto', soakMinutes: 30 } },
      testingUrl: null,
      fileError: '.github/fleetadlc.yml: production.approval: Invalid enum value',
    });
    expect(said.rules.join(' ')).toContain('with no reviewer, after 30 minutes on testing');
    expect(said.source).toContain('testing deploy choice');
    expect(said.problem).toContain('production.approval');
    // The file is there; it is the error that is shown next, not "it has no file".
    expect(said.source).toBe('From the testing deploy choice above, because .github/fleetadlc.yml could not be read:');
  });

  it('says a repository without the file has none, and one whose file did not parse could not be read', () => {
    const absent = deliveryLines({ source: 'repository', rules, testingUrl: null, fileError: null });
    expect(absent.source).toBe('From OpenADLC’s stored rules for this repository, since it has no .github/fleetadlc.yml.');
    const broken = deliveryLines({ source: 'repository', rules, testingUrl: null, fileError: '.github/fleetadlc.yml: not YAML' });
    expect(broken.source).toBe('From OpenADLC’s stored rules for this repository, because .github/fleetadlc.yml could not be read:');
  });

  it('says merging ships it where testing is none', () => {
    expect(deliveryLines({ source: 'repository', rules: { ...rules, testing: { ...rules.testing, on: 'none' } }, testingUrl: null, fileError: null }).rules).toEqual([
      'Merging ships it: no testing deploy, nothing to promote.',
    ]);
  });
});

describe('saving a repository’s settings while other saves are in flight', () => {
  type Answer = { ok: boolean; error?: string };
  /** Each save waits until the test answers it, in whatever order the test chooses. */
  let waiting: { patch: Record<string, unknown>; answer: (result: Answer) => void }[];
  let container: HTMLElement;
  let root: Root;

  const draw = async (repo: RepoSettingsRepo = REPO) => {
    await act(async () => root.render(<RepoSettings repo={repo} owner={BUILDER} builders={3} reviewers={3} maxReviewRounds={3} />));
  };
  const radio = (group: string, label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] [role="radio"]`)].find(
      (button) => button.textContent === label || button.getAttribute('aria-label') === label,
    )!;
  const chosen = (group: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] [role="radio"]`)].find((button) => button.getAttribute('aria-checked') === 'true');
  const press = async (button: HTMLButtonElement) => act(async () => button.click());
  const answer = async (index: number, result: Answer) =>
    act(async () => {
      waiting[index]!.answer(result);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    waiting = [];
    vi.mocked(updateRepoSettings).mockImplementation(
      (_name, patch) => new Promise((resolve) => waiting.push({ patch: patch as Record<string, unknown>, answer: resolve })),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.mocked(updateRepoSettings).mockImplementation(async () => saved.answer);
  });

  it('sends only the stage that changed, for the bridge to merge into what it has', async () => {
    await draw();
    await press(radio('Design', 'Always'));
    expect(waiting.map((one) => one.patch)).toEqual([{ stageModes: { spec: 'autonomous' } }]);
  });

  it('keeps a save that landed before a newer one answered, so a later refusal does not put it back', async () => {
    await draw();
    await press(radio('Design', 'Always'));
    const other = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Color"] [role="radio"]')].find(
      (button) => button.getAttribute('aria-checked') !== 'true',
    )!;
    await press(other);
    // The colour answers first, then Design: both saved.
    await answer(1, { ok: true });
    await answer(0, { ok: true });
    // A later change is refused; Design stays as the bridge has it.
    await press(container.querySelector<HTMLButtonElement>('[aria-label="More"]')!);
    await answer(2, { ok: false, error: 'the bridge is restarting' });
    expect(chosen('Design')?.textContent).toBe('Always');
    expect(container.textContent).toContain('the bridge is restarting');
  });

  it('puts back what a refused older save carried, and only that', async () => {
    await draw();
    await press(radio('Design', 'Always'));
    const other = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Color"] [role="radio"]')].find(
      (button) => button.getAttribute('aria-checked') !== 'true',
    )!;
    await press(other);
    await answer(1, { ok: true });
    // Design's answer arrives last, refused: it was dropped, and the page said "Saved" over a stage the bridge never took.
    await answer(0, { ok: false, error: 'this needs an admin' });
    expect(chosen('Design')?.textContent).toBe('When it matters');
    expect(chosen('Color')).toBe(other);
    expect(container.textContent).toContain('this needs an admin');
  });

  it('takes what the page read again while nothing is being saved', async () => {
    await draw();
    expect(chosen('Design')?.textContent).toBe('When it matters');
    // Another admin chose Always; the page's next read says so.
    await draw({ ...REPO, stageModes: { ...REPO.stageModes, spec: 'autonomous' } });
    expect(chosen('Design')?.textContent).toBe('Always');
  });
});
