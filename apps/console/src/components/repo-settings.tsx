'use client';

import { useRouter } from 'next/navigation';
import { DesignMemorySection } from '@/components/design-memory';
import { Fragment, useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { pauseWork, removeRepository, repositoryRemoval, resumeWork, updateRepoSettings } from '@/app/actions';
import { BotAvatar } from '@/components/avatar';
import { ColorChoice, REPO_SWATCHES } from '@/components/color-choice';
import { CheckIcon, ExternalIcon } from '@/components/icons';
import { RepoDot } from '@/components/repo-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { DesignMemoryEntry, CrewMember, RemovalChoices, RemovalPreview, RemovalReport, RepoDelivery, WorkPause } from '@/lib/api';
import { pauseLine } from '@/components/pause-work';
import { botLabel } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { roleTitle } from '@/lib/crew';
import { safeAction } from '@/lib/safe-action';
import { modeIsSettable, type StageKey } from '@/lib/stages';
import { modeOf, SETTINGS_STAGES, stageChoices, stageLine, tasksAtOnceLine, type StageChoice } from '@/lib/settings';

export interface RepoSettingsRepo {
  name: string;
  fullName?: string | null;
  concurrency: number;
  stageModes: Record<string, string>;
  owner: string | null;
  specRequiredLabels?: string[];
  /** A name from the palette. Absent from a bridge older than colours. */
  color?: string | null;
  /** Automatic when the bridge has not said. See Settings → Repositories. */
  testingDeploy?: 'automatic' | 'has' | 'none';
  /** What automatic resolved to, or the explicit answer. Null when GitHub could not be asked. */
  shipsByMerging?: boolean | null;
  /** How it ships, by its rules, and where they came from. Absent from an older bridge. */
  delivery?: RepoDelivery | null;
}

/**
 * How a repository ships, as lines a person reads: what happens after a
 * merge, what holds production, and where the rules came from. The rules
 * decide; OpenADLC dispatches and never approves an environment.
 */
export function deliveryLines(delivery: RepoDelivery): { rules: string[]; source: string; problem: string | null } {
  const { testing, production } = delivery.rules;
  const rules: string[] = [];
  if (testing.on === 'none') {
    rules.push('Merging ships it: no testing deploy, nothing to promote.');
  } else {
    rules.push(`A merge runs ${testing.workflow}, then ${testing.smoke} on testing${delivery.testingUrl ? ` (${delivery.testingUrl})` : ''}.`);
    if (production.on === 'none') rules.push('Testing is as far as it goes.');
    else if (production.approval === 'reviewers')
      rules.push(
        `A green smoke dispatches ${production.workflow} once a person approves it: the production environment's required reviewers, ` +
          'or, where GitHub’s plan cannot hold a reviewer, a person releasing it from Needs you.',
      );
    else
      rules.push(
        `A green smoke dispatches ${production.workflow} with no reviewer${production.soakMinutes > 0 ? `, after ${production.soakMinutes} minutes on testing` : ''}.`,
      );
    if (production.on !== 'none') rules.push(`A failed production deploy runs ${production.rollback} and goes back to build.`);
  }
  // The bridge falls back the same way when the file is there and cannot be
  // read, and the error is shown on the next line: "since it has no file"
  // over that file's own error left a person unsure it was read at all.
  const why = delivery.fileError ? 'because .github/fleetadlc.yml could not be read:' : 'since it has no .github/fleetadlc.yml.';
  const source =
    delivery.source === 'file'
      ? 'From .github/fleetadlc.yml on the default branch: change it by a pull request.'
      : delivery.source === 'repository'
        ? `From OpenADLC’s stored rules for this repository, ${why}`
        : `From the testing deploy choice above, ${why}`;
  return { rules, source, problem: delivery.fileError };
}

type TestingDeployChoice = 'automatic' | 'has' | 'none';

const TESTING_DEPLOY: { mode: TestingDeployChoice; label: string }[] = [
  { mode: 'automatic', label: 'Automatic' },
  { mode: 'has', label: 'Has a testing deploy' },
  { mode: 'none', label: 'No testing deploy' },
];

/** What Automatic found, under the control. */
function testingDeployResolved(ships: boolean | null | undefined): string {
  if (ships === true) return 'No testing deploy for this repository. Merging ships it.';
  if (ships === false) return 'This repository has a testing deploy.';
  return 'Could not tell whether a deploy-testing workflow exists.';
}

/**
 * The sentence the page opened with. An explicit choice has none: that line is
 * what a later Automatic save resolves, and the props still hold the first load.
 */
function openedResolution(repo: RepoSettingsRepo): boolean | null | undefined {
  if ((repo.testingDeploy ?? 'automatic') !== 'automatic') return undefined;
  return repo.shipsByMerging ?? null;
}

type Saving = { state: 'idle' } | { state: 'saving' } | { state: 'saved' } | { state: 'failed'; reason: string };

type SettingsPatch = {
  stageModes?: Record<string, string>;
  concurrency?: number;
  color?: string;
  testingDeploy?: TestingDeployChoice;
};

/** What a change carries, one field per stage: what a refusal puts back, and what a later answer may overwrite. */
function fieldsOf(patch: SettingsPatch): string[] {
  return [
    ...Object.keys(patch.stageModes ?? {}).map((stage) => `stage:${stage}`),
    ...(patch.concurrency !== undefined ? ['concurrency'] : []),
    ...(patch.color !== undefined ? ['color'] : []),
    ...(patch.testingDeploy !== undefined ? ['deploy'] : []),
  ];
}

/**
 * One repository's settings: who builds it and how many tasks at once, what
 * each stage may do without asking, the colour the board tells it apart by,
 * and taking it out of OpenADLC. Every change is saved as it is made, through the
 * same audited route the page always used, and the line at the top says when
 * it has been — or, when it was refused, why, with the control put back to
 * what is actually stored.
 */
export function RepoSettings({
  repo,
  owner,
  builders,
  reviewers,
  maxReviewRounds,
  pause = null,
  installPaused = false,
  designMemory,
}: {
  repo: RepoSettingsRepo;
  /** The bot the repository is built by, from the crew. */
  owner: CrewMember | null;
  /** How many tasks this repository's builders can run at once between them: the owner and every other bot with its role, each up to its own tasks at once (`buildersOf`). */
  builders: number;
  /** How many reviewers the crew has, for the Review stage's line. */
  reviewers: number;
  maxReviewRounds: number | null;
  /** This repository's own pause, when a person paused it. */
  pause?: WorkPause | null;
  /** Whether work is paused across the install, which holds this one whatever its own pause says. */
  installPaused?: boolean;
  /** What the design stage remembers about it; absent where the page did not read it. */
  designMemory?: readonly DesignMemoryEntry[];
}) {
  const [modes, setModes] = useState<Record<string, string>>(repo.stageModes ?? {});
  const [concurrency, setConcurrency] = useState(repo.concurrency);
  const [color, setColor] = useState<string | null>(repo.color ?? null);
  const [deploy, setDeploy] = useState<TestingDeployChoice>(repo.testingDeploy ?? 'automatic');
  /** What the last Automatic save resolved to. Hidden until that save, when the page opened on Has or None. */
  const [resolved, setResolved] = useState<boolean | null | undefined>(openedResolution(repo));
  const [saving, setSaving] = useState<Saving>({ state: 'idle' });
  /** What the bridge last confirmed, to go back to when a change is refused. */
  const stored = useRef({
    modes: repo.stageModes ?? {},
    concurrency: repo.concurrency,
    color: repo.color ?? null,
    deploy: (repo.testingDeploy ?? 'automatic') as TestingDeployChoice,
    resolved: openedResolution(repo),
  });
  /** Which change last set each field on screen, and which change's answer `stored` holds for it. */
  const touched = useRef<Record<string, number>>({});
  const confirmed = useRef<Record<string, number>>({});
  /** Changes not yet answered: the page's own reads are taken only while there are none. */
  const inFlight = useRef(0);
  /** Only the newest change's success is said: an older one arriving late says nothing about now. */
  const latest = useRef(0);
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (fade.current && clearTimeout(fade.current)), []);

  // The page is read again every fifteen seconds; what it read is taken here
  // while nothing is being saved. Read once, a stage another admin changed
  // stayed as it was on this screen until a reload.
  const server = JSON.stringify([repo.stageModes ?? {}, repo.concurrency, repo.color ?? null, repo.testingDeploy ?? 'automatic', repo.shipsByMerging]);
  const read = useRef(server);
  useEffect(() => {
    if (read.current === server || inFlight.current > 0) return;
    read.current = server;
    stored.current = {
      modes: repo.stageModes ?? {},
      concurrency: repo.concurrency,
      color: repo.color ?? null,
      deploy: repo.testingDeploy ?? 'automatic',
      resolved: openedResolution(repo),
    };
    setModes(stored.current.modes);
    setConcurrency(stored.current.concurrency);
    setColor(stored.current.color);
    setDeploy(stored.current.deploy);
    setResolved(stored.current.resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  const save = async (patch: SettingsPatch): Promise<void> => {
    const mine = ++latest.current;
    const fields = fieldsOf(patch);
    for (const field of fields) touched.current[field] = mine;
    inFlight.current += 1;
    if (fade.current) clearTimeout(fade.current);
    setSaving({ state: 'saving' });
    const result = await safeAction(() => updateRepoSettings(repo.name, patch));
    inFlight.current -= 1;
    if (result.ok) {
      // Every answer that saved is what the bridge has, in whatever order the
      // answers came: only the newest was kept, and a later refusal put a
      // control back to a value the bridge no longer held.
      const takes = (field: string): boolean => (confirmed.current[field] ?? 0) < mine;
      const was = stored.current;
      const modes = { ...was.modes };
      for (const [stage, mode] of Object.entries(patch.stageModes ?? {})) if (takes(`stage:${stage}`)) modes[stage] = mode;
      const deploy = patch.testingDeploy !== undefined && takes('deploy') ? patch.testingDeploy : was.deploy;
      // A color or a stage does not change what Automatic found. A testing-deploy
      // save does, and a missing answer is "could not tell", not the first load.
      const resolved =
        patch.testingDeploy !== undefined && takes('deploy') ? (deploy === 'automatic' ? (result.shipsByMerging ?? null) : undefined) : was.resolved;
      stored.current = {
        modes,
        concurrency: patch.concurrency !== undefined && takes('concurrency') ? patch.concurrency : was.concurrency,
        color: patch.color !== undefined && takes('color') ? patch.color : was.color,
        deploy,
        resolved,
      };
      for (const field of fields) if (takes(field)) confirmed.current[field] = mine;
      if (patch.testingDeploy !== undefined && touched.current.deploy === mine) setResolved(resolved);
      if (mine === latest.current) {
        setSaving({ state: 'saved' });
        fade.current = setTimeout(() => setSaving({ state: 'idle' }), 2500);
      }
    } else {
      // What this change carried goes back to what is stored, unless a newer
      // change has set it since; a refusal of one says nothing about the other.
      const own = (field: string): boolean => touched.current[field] === mine;
      const was = stored.current;
      for (const stage of Object.keys(patch.stageModes ?? {})) {
        if (!own(`stage:${stage}`)) continue;
        setModes((now) => {
          const next = { ...now };
          if (stage in was.modes) next[stage] = was.modes[stage]!;
          else delete next[stage];
          return next;
        });
      }
      if (patch.concurrency !== undefined && own('concurrency')) setConcurrency(was.concurrency);
      if (patch.color !== undefined && own('color')) setColor(was.color);
      if (patch.testingDeploy !== undefined && own('deploy')) {
        setDeploy(was.deploy);
        setResolved(was.resolved);
      }
      setSaving({ state: 'failed', reason: result.error ?? 'the bridge refused it' });
    }
  };

  const choose = (stage: StageKey, mode: string): void => {
    if (modeOf(modes, stage) === mode) return;
    setModes({ ...modes, [stage]: mode });
    // The one stage, which the bridge merges into what it has: the whole map
    // was built from this tab's last read, and put back what changed since.
    void save({ stageModes: { [stage]: mode } });
  };

  const step = (by: number): void => {
    const next = concurrency + by;
    setConcurrency(next);
    void save({ concurrency: next });
  };

  const paint = (next: string): void => {
    if (next === color) return;
    setColor(next);
    void save({ color: next });
  };

  const chooseDeploy = (next: string): void => {
    if (next !== 'automatic' && next !== 'has' && next !== 'none') return;
    if (next === deploy) return;
    setDeploy(next);
    // The sentence under Automatic is the page's first load until this returns.
    // Hide it now, or a switch from Has or None shows that resolution.
    setResolved(undefined);
    void save({ testingDeploy: next });
  };

  const most = Math.max(builders, repo.concurrency, 1);
  const labels = repo.specRequiredLabels ?? [];
  const ownerLabel = owner ? botLabel(owner) : null;

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[19px] font-semibold tracking-[-0.01em] text-body">
          <RepoDot color={color} className="mr-2 size-2.5 align-middle" />
          {repo.name}
        </h3>
        {repo.fullName && (
          <a
            href={`https://github.com/${repo.fullName}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12.5px] text-link hover:underline"
          >
            {repo.fullName}
            <ExternalIcon size={11} />
          </a>
        )}
        <SaveLine saving={saving} />
      </div>

      <section aria-labelledby={`${repo.name}-who`} className="flex flex-col gap-3.5 rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
        <h4 id={`${repo.name}-who`} className="text-[13.5px] font-semibold text-body">
          Who builds it
        </h4>
        {owner && ownerLabel ? (
          <div className="flex items-center gap-2.5">
            <BotAvatar bot={owner} size="chat" />
            <span className="text-[13px]">
              <span className="font-semibold text-body">{ownerLabel.handle ?? roleTitle(owner)}</span>
              <span className="text-muted"> · {ownerLabel.handle ? roleTitle(owner) : 'not connected yet'}</span>
            </span>
          </div>
        ) : (
          <p className="text-[13px] text-muted">No bot owns this repository, so nothing is built here.</p>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-well pt-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium text-body">Tasks at once</span>
            <span className="text-[12px] leading-snug text-muted">{tasksAtOnceLine(builders)}</span>
          </div>
          <div role="group" aria-label="Tasks at once" className="flex items-center overflow-hidden rounded-md border border-edge-strong">
            <button
              type="button"
              aria-label="Fewer"
              disabled={concurrency <= 1}
              onClick={() => step(-1)}
              className="h-11 w-11 bg-surface text-[15px] text-soft transition-colors hover:bg-well disabled:text-edge-strong disabled:hover:bg-surface md:h-8 md:w-[34px]"
            >
              −
            </button>
            <span aria-live="polite" className="w-10 text-center text-[13px] font-medium text-body">
              {concurrency}
            </span>
            <button
              type="button"
              aria-label="More"
              disabled={concurrency >= most}
              title={concurrency >= most ? 'Its builders run no more at once: raise a builder’s tasks at once on the Crew page, or add a builder' : undefined}
              onClick={() => step(1)}
              className="h-11 w-11 bg-surface text-[15px] text-soft transition-colors hover:bg-well disabled:text-edge-strong disabled:hover:bg-surface md:h-8 md:w-[34px]"
            >
              +
            </button>
          </div>
        </div>
      </section>

      <section aria-labelledby={`${repo.name}-stages`} className="flex flex-col gap-1 rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
        <h4 id={`${repo.name}-stages`} className="text-[13.5px] font-semibold text-body">
          What each stage may do without asking
        </h4>
        <p className="mb-2 text-[12.5px] leading-normal text-muted">
          Each stage runs on its own and shows up on the board; a bot asks you, in Needs you, when it needs something.
          Design is the one stage with a choice, because a change can skip it. What releases production is not a
          setting here: the repository’s delivery rules, under Testing deploy, say whether a person approves it or it
          ships on its own.
        </p>

        {SETTINGS_STAGES.map(({ key, title }) => {
          const line = stageLine(key, { reviewers, maxReviewRounds });
          if (!modeIsSettable(key)) {
            return (
              <div key={key} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-well pb-0.5 pt-3">
                <StageName title={title} line={line} />
                <span className="text-[12.5px] text-dim">Always on its own</span>
              </div>
            );
          }
          const mode = modeOf(modes, key);
          const choices = stageChoices(key, mode);
          if (choices.length === 1) {
            return (
              <div key={key} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-well pb-0.5 pt-3">
                <StageName title={title} line={line} />
                <span className="text-[12.5px] text-dim">{choices[0]!.label}</span>
              </div>
            );
          }
          return (
            <div key={key} className="flex flex-col gap-2 border-t border-well py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <StageName title={title} line={line} />
                <Segmented label={title} choices={choices} value={mode} onChoose={(next) => choose(key, next)} />
              </div>
              {key === 'spec' && mode === 'conditional' && (
                <p className="rounded-md bg-surface px-2.5 py-2 text-[12px] leading-normal text-soft">
                  {labels.length === 0 ? (
                    'No label asks for a design pass here, so no issue gets one.'
                  ) : (
                    <>
                      Only issues labelled{' '}
                      {labels.map((label, index) => (
                        <Fragment key={label}>
                          {index > 0 && (index === labels.length - 1 ? ' or ' : ', ')}
                          <span className="font-medium text-body">{label}</span>
                        </Fragment>
                      ))}{' '}
                      get a design pass.
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}
      </section>

      <section aria-labelledby={`${repo.name}-deploy`} className="flex flex-col gap-2 rounded-[10px] border border-edge bg-panel px-5 py-[18px]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
            <h4 id={`${repo.name}-deploy`} className="text-[13px] font-semibold text-body">
              Testing deploy
            </h4>
            <span className="text-[12px] leading-snug text-muted">
              Automatic follows whether a deploy-testing workflow exists. No testing deploy means a merge goes straight to Done.
            </span>
          </div>
          <Segmented label="Testing deploy" choices={TESTING_DEPLOY} value={deploy} onChoose={chooseDeploy} />
        </div>
        {deploy === 'automatic' && resolved !== undefined && (
          <p className="text-[12px] leading-snug text-soft">{testingDeployResolved(resolved)}</p>
        )}
        {repo.delivery && (
          <div className="flex flex-col gap-1 border-t border-well pt-2">
            {deliveryLines(repo.delivery).rules.map((line) => (
              <p key={line} className="text-[12px] leading-snug text-soft">
                {line}
              </p>
            ))}
            <p className="text-[12px] leading-snug text-muted">{deliveryLines(repo.delivery).source}</p>
            {repo.delivery.fileError && <p className="text-[12px] leading-snug text-alarm">{repo.delivery.fileError}</p>}
          </div>
        )}
      </section>

      {designMemory && <DesignMemorySection repo={repo.name} entries={designMemory} />}

      <section aria-label={`${repo.name} on the board`} className="flex flex-col rounded-[10px] border border-edge bg-panel px-5 py-1.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
          <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-semibold text-body">Color</span>
            <span className="text-[12px] leading-snug text-muted">
              How the board tells it apart when it shows every repository, always beside its name.
            </span>
          </div>
          <ColorChoice label="Color" swatches={REPO_SWATCHES} value={color} onChoose={(next) => next && paint(next)} />
        </div>
        <RepoPause name={repo.name} initial={pause} installPaused={installPaused} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-well py-3">
          <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-semibold text-body">Remove from OpenADLC</span>
            <span className="text-[12px] leading-snug text-muted">
              OpenADLC stops its work here, takes the crew’s access away and takes it off the board, after showing you what that ends.
              Nothing on GitHub is deleted unless you choose to delete OpenADLC’s labels.
            </span>
          </div>
          <RemoveRepository name={repo.name} fullName={repo.fullName ?? null} />
        </div>
      </section>
    </div>
  );
}

/**
 * This repository's pause, the one Settings → Pause work lists among the
 * rest: who paused it and why, and Resume; or Pause, asked twice, which stops
 * new work here alone.
 */
function RepoPause({ name, initial, installPaused }: { name: string; initial: WorkPause | null; installPaused: boolean }) {
  const [pause, setPause] = useState<WorkPause | null>(initial);
  // Taken from each read of the page, as Settings → Pause work does: a pause
  // made elsewhere since showed Pause here, not who paused it and Resume.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setPause(initial);
  }
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const act = (work: () => Promise<{ ok: boolean; error?: string; pauses?: { repos: Record<string, WorkPause> } }>) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      setAsking(false);
      if (!result.ok) setError(result.error ?? 'that did not go through');
      else setPause(result.pauses?.repos[name] ?? null);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-well py-3">
      <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-body">Pause work</span>
        <span className={cn('text-[12px] leading-snug', pause ? 'text-attention' : 'text-muted')}>
          {pause
            ? `${pauseLine(pause)} Nothing new starts here until it is resumed; the other repositories go on.`
            : installPaused
              ? 'Work is paused across the install, which holds this repository too; resume it in Settings → Pause work.'
              : 'Stop new work here alone: no leases, no triage of its requests, no Try again. Work already running finishes.'}
        </span>
        {error && <span className="text-[12px] text-alarm">{error}</span>}
      </div>
      {pause ? (
        <Button size="sm" variant="primary" disabled={pending} onClick={() => act(() => resumeWork([name]))}>
          {pending ? 'Resuming…' : 'Resume'}
        </Button>
      ) : asking ? (
        <div role="group" aria-label="Confirm" className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-medium text-body">Pause new work in {name}?</span>
          <Button type="button" size="sm" variant="danger" disabled={pending} onClick={() => act(() => pauseWork('', [name]))}>
            {pending ? 'Pausing…' : 'Confirm'}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="danger" disabled={pending} onClick={() => setAsking(true)}>
          Pause
        </Button>
      )}
    </div>
  );
}

/** What the review step starts with: the crew's access goes, OpenADLC's labels stay. */
export const REMOVAL_DEFAULTS: RemovalChoices = { crewAccess: true, labels: false, maybeTheirs: false };

/**
 * Taking a repository out of OpenADLC, in one flow: a review step that says what
 * it has now and what removing it does to each, two choices, and, when a step
 * could not be done, what is left and what finishes it. It is a word people
 * read as "delete", and nothing is deleted unless the person chooses to
 * delete OpenADLC's labels.
 */
function RemoveRepository({ name, fullName }: { name: string; fullName: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RemovalPreview | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  /** The read was refused for who is asking, so removing it would be too. */
  const [refused, setRefused] = useState(false);
  const [choices, setChoices] = useState<RemovalChoices>(REMOVAL_DEFAULTS);
  const [report, setReport] = useState<RemovalReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const called = fullName ?? name;

  // Its page has nothing left to show once it is removed; back to the list it was taken off.
  const leave = (): void => {
    setOpen(false);
    router.push('/settings#repository');
    router.refresh();
  };

  const read = async (): Promise<void> => {
    setPreview(null);
    setReport(null);
    setError(null);
    setChoices(REMOVAL_DEFAULTS);
    // Null while the read is in flight, so Remove stays disabled until the
    // review is on screen or the read has failed and said it can still go.
    setReading(null);
    setRefused(false);
    const result = await repositoryRemoval(name);
    if (result.ok && result.removal) {
      setPreview(result.removal);
      setReading(null);
    } else if (result.refused) {
      setRefused(true);
      setReading(`Could not read what OpenADLC has going there: ${result.error ?? 'the bridge refused it'}.`);
    } else {
      setReading(`Could not read what OpenADLC has going there: ${result.error ?? 'the bridge did not say'}. It can still be removed.`);
    }
  };

  const remove = (): void => {
    setError(null);
    startTransition(async () => {
      const result = await removeRepository(name, choices);
      if (!result.ok || !result.report) {
        setError(result.error ?? 'the bridge refused it');
        return;
      }
      if (result.report.notDone.length === 0) leave();
      else setReport(result.report);
    });
  };

  const change = (next: boolean): void => {
    if (pending) return;
    // Once it is removed there is no page to close back to.
    if (!next && report) return leave();
    setOpen(next);
    if (next) void read();
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button variant="danger" size="sm" className="h-11 shrink-0 px-3 md:h-7">
          Remove from OpenADLC
        </Button>
      </DialogTrigger>
      <DialogContent>
        {report ? (
          <>
            <DialogTitle>{called} is removed from OpenADLC</DialogTitle>
            <DialogDescription>Some of it could not be done. Each line says what is left and what finishes it.</DialogDescription>
            <RemovalOutcome report={report} />
            {error && (
              <p role="alert" className="mt-2.5 text-[12.5px] text-alarm">
                {error}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              {report.notDone.some((one) => 'retry' in one.action) && (
                <Button size="sm" variant="ghost" className="h-11 md:h-7" disabled={pending} onClick={remove}>
                  {pending ? 'Trying again…' : 'Remove from OpenADLC again'}
                </Button>
              )}
              <Button size="sm" variant="primary" className="h-11 md:h-7" disabled={pending} onClick={leave}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogTitle>Remove {called} from OpenADLC?</DialogTitle>
            <DialogDescription>
              OpenADLC stops working in it and it leaves the board. Here is what it has going there now, and what removing it does to each.
            </DialogDescription>
            {!preview && (
              <p className="mt-2.5 text-[12.5px] text-muted">{reading ?? 'Reading what OpenADLC has going there…'}</p>
            )}
            {preview && <RemovalReview preview={preview} choices={choices} onChange={setChoices} disabled={pending} />}
            {error && (
              <p role="alert" className="mt-2.5 text-[12.5px] text-alarm">
                Not removed: {error}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <DialogClose asChild>
                <Button size="sm" variant="ghost" className="h-11 md:h-7" disabled={pending}>
                  Keep it
                </Button>
              </DialogClose>
              <Button size="sm" variant="danger" className="h-11 md:h-7" disabled={pending || refused || (!preview && !reading)} onClick={remove}>
                {pending ? 'Removing…' : 'Remove from OpenADLC'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const TASK_STATE: Record<string, string> = { queued: 'queued', running: 'running', paused: 'waiting on a question' };

/**
 * The review step: what the repository has now, and what removing it does to
 * each, before anything is pressed. The crew's access is a choice, on by
 * default; OpenADLC's labels are one, off by default, since deleting a label
 * takes it off every issue and pull request.
 */
export function RemovalReview({
  preview,
  choices,
  onChange,
  disabled = false,
}: {
  preview: RemovalPreview;
  choices: RemovalChoices;
  onChange: (next: RemovalChoices) => void;
  disabled?: boolean;
}) {
  const collaborators = preview.crew.accounts.filter((one) => one.state === 'collaborator');
  const invited = preview.crew.accounts.filter((one) => one.state === 'invited');
  const owner = preview.repository.split('/')[0] ?? '';
  return (
    <div className="mt-2.5 flex flex-col text-[13px] leading-relaxed text-body">
      <ReviewGroup title="Work in flight">
        {preview.tasks.length === 0 ? (
          <p className="text-muted">Nothing is running, queued or waiting there.</p>
        ) : (
          <>
            <p className="text-muted">Stopped, as Stop on its card would, and audited.</p>
            <ul className="flex flex-col gap-1">
              {preview.tasks.map((task) => (
                <li key={task.id}>
                  {task.subject}: {task.bot ?? 'a bot'}’s {task.kind}, {TASK_STATE[task.state] ?? task.state}
                  {task.question && <span className="text-muted"> — “{task.question}”</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {preview.questions.length > 0 && (
          <p>
            {preview.questions.length === 1
              ? 'Its open question is closed and leaves Needs you.'
              : `Its ${preview.questions.length} open questions are closed and leave Needs you.`}
          </p>
        )}
        {preview.leases.length > 0 && (
          <p>
            {preview.leases.length === 1 ? 'The claim' : `The ${preview.leases.length} claims`} on{' '}
            {preview.leases.map((lease) => `#${lease.issue}`).join(', ')} {preview.leases.length === 1 ? 'is' : 'are'} released.
          </p>
        )}
      </ReviewGroup>

      <ReviewGroup title="The crew’s access">
        <ReviewChoice
          checked={choices.crewAccess}
          disabled={disabled}
          onChange={(crewAccess) => onChange({ ...choices, crewAccess })}
          line={
            !preview.crew.known
              ? `OpenADLC could not ask GitHub who is there (${preview.crew.reason ?? 'no answer'}); it tries again when removing.`
              : collaborators.length + invited.length === 0
                ? 'None of the crew’s accounts is a collaborator or invited.'
                : [
                    collaborators.length > 0 ? `Collaborators: ${collaborators.map((one) => one.login).join(', ')}.` : '',
                    invited.length > 0 ? `Invited: ${invited.map((one) => one.login).join(', ')}.` : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
          }
        >
          Take the crew off its collaborators and cancel their invitations
        </ReviewChoice>
      </ReviewGroup>

      <ReviewGroup title="OpenADLC’s labels">
        <ReviewChoice
          checked={choices.labels}
          disabled={disabled}
          onChange={(labels) => onChange({ ...choices, labels })}
          line={
            <>
              Deleting a label also takes it off every issue and pull request.{' '}
              {!preview.labels.known
                ? `OpenADLC could not read its labels (${preview.labels.reason ?? 'no answer'}).`
                : preview.labels.names.length === 0
                  ? 'It has none of them.'
                  : `It has ${preview.labels.names.length}: ${preview.labels.names.join(', ')}.`}
            </>
          }
        >
          Remove OpenADLC’s labels (those in config/labels.json)
        </ReviewChoice>
        {(preview.labels.maybeTheirs ?? []).length > 0 && (
          <ReviewChoice
            checked={choices.maybeTheirs ?? false}
            disabled={disabled}
            onChange={(maybeTheirs) => onChange({ ...choices, maybeTheirs })}
            line={`OpenADLC uses these names too, but the repository may have had them first: ${(preview.labels.maybeTheirs ?? []).join(', ')}.`}
          >
            Also remove the labels that may be the repository’s own
          </ReviewChoice>
        )}
      </ReviewGroup>

      <ReviewGroup title="The GitHub App">
        {preview.app.allRepositories ? (
          <p>
            It is installed on all of {owner}’s repositories, so it still reaches this one. OpenADLC cannot change that; choose “Only select
            repositories”
            {preview.app.settingsUrl ? (
              <>
                {' '}
                <a href={preview.app.settingsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
                  in the installation’s settings <ExternalIcon size={11} />
                </a>
              </>
            ) : (
              ' in the GitHub App installation’s settings'
            )}
            .
          </p>
        ) : preview.app.allRepositories === false ? (
          <p className="text-muted">It reaches only the repositories it was given. Take this one off that list in the GitHub App installation’s settings if you want it gone.</p>
        ) : (
          <p className="text-muted">OpenADLC could not read where the app is installed{preview.app.reason ? `: ${preview.app.reason}` : ''}.</p>
        )}
      </ReviewGroup>

      <ReviewGroup title="Left as they are">
        <p className="text-muted">
          {preview.leftAlone} Its issues, pull requests and branches stay on GitHub, and what the crew did stays in OpenADLC’s history and costs.
          Add it again and it comes back with these settings; the crew’s access and the labels are set up again as when it was first added.
        </p>
      </ReviewGroup>
    </div>
  );
}

/** What a removal could not do, a line each, with the button that finishes it. */
export function RemovalOutcome({ report }: { report: RemovalReport }) {
  const done = [
    report.stopped.length > 0 ? `${report.stopped.length} task${report.stopped.length === 1 ? '' : 's'} stopped` : '',
    report.questionsClosed > 0 ? `${report.questionsClosed} question${report.questionsClosed === 1 ? '' : 's'} closed` : '',
    report.leasesReleased.length > 0 ? `${report.leasesReleased.length} claim${report.leasesReleased.length === 1 ? '' : 's'} released` : '',
    report.collaboratorsRemoved.length > 0 ? `${report.collaboratorsRemoved.join(', ')} taken off` : '',
    report.invitationsCancelled.length > 0 ? `invitations cancelled for ${report.invitationsCancelled.join(', ')}` : '',
    report.labelsRemoved.length > 0 ? `${report.labelsRemoved.length} label${report.labelsRemoved.length === 1 ? '' : 's'} deleted` : '',
  ].filter(Boolean);
  return (
    <div className="mt-2.5 flex flex-col gap-2 text-[13px] leading-relaxed">
      {done.length > 0 && <p className="text-muted">Done: {done.join('; ')}.</p>}
      <ul aria-label="Not done" className="flex flex-col gap-2">
        {report.notDone.map((leftover, index) => (
          <li key={`${leftover.step}-${index}`} className="flex flex-col gap-0.5 rounded-lg bg-well px-3 py-2">
            <span className="text-body">{leftover.what}</span>
            <span className="text-[12px] text-muted">{leftover.why}</span>
            {'url' in leftover.action && (
              <a
                href={leftover.action.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 self-start text-[12.5px] text-link hover:underline"
              >
                {leftover.action.label} <ExternalIcon size={11} />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5 border-t border-well py-3 first:border-t-0 first:pt-0">
      <span className="text-[12px] font-semibold text-muted">{title}</span>
      {children}
    </section>
  );
}

function ReviewChoice({
  checked,
  onChange,
  disabled,
  children,
  line,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  children: ReactNode;
  line: ReactNode;
}) {
  return (
    <label className={cn('flex items-start gap-2.5', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-[3px] size-4 shrink-0 accent-link"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body">{children}</span>
        <span className="text-[12px] leading-snug text-muted">{line}</span>
      </span>
    </label>
  );
}

function StageName({ title, line }: { title: string; line: string }) {
  return (
    <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
      <span className="text-[13px] font-semibold text-body">{title}</span>
      <span className="text-[12px] leading-snug text-muted">{line}</span>
    </div>
  );
}

/** One choice of a few, pressed in place: the stage's mode, in words. */
function Segmented({
  label,
  choices,
  value,
  onChoose,
}: {
  label: string;
  choices: StageChoice[];
  value: string;
  onChoose: (mode: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-lg bg-well p-0.5">
      {choices.map((choice) => {
        const checked = choice.mode === value;
        return (
          <button
            key={choice.mode}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChoose(choice.mode)}
            className={cn(
              'h-10 rounded-md px-3 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-link md:h-[30px]',
              checked ? 'bg-panel font-medium text-body shadow-sm' : 'text-muted hover:text-body',
            )}
          >
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

/** "Changes save as you make them", then "Saving…", "Saved", or why it was not. */
function SaveLine({ saving }: { saving: Saving }) {
  if (saving.state === 'failed') {
    return (
      <span role="alert" className="ml-auto text-[12px] text-alarm">
        Not saved: {saving.reason}
      </span>
    );
  }
  return (
    <span role="status" className="ml-auto inline-flex items-center gap-[5px] text-[12px] text-dim">
      {saving.state !== 'saving' && <CheckIcon size={13} className="text-signal" />}
      {saving.state === 'saving' ? 'Saving…' : saving.state === 'saved' ? 'Saved' : 'Changes save as you make them'}
    </span>
  );
}
