'use client';

import { useState } from 'react';
import type { ReleasePreparation, ReleasePrepareOffer } from '@/lib/api';

/**
 * Prepare next version (#363, docs/adr/0078): on a release page whose head
 * version is not above the last release, the version to raise to — the
 * suggestion, editable — and Send. The bridge files a console request for the
 * crew in the person's name; the version is raised by a crew pull request,
 * and nothing is built, tagged or pushed by this. A refusal — a version not
 * above the last release, one already open — is said beside the field.
 */

const STATE: Record<ReleasePreparation['state'], string> = {
  queued: 'waiting for intake',
  draft: 'being triaged',
  questions: 'waiting on your answers',
  filed: 'filed for the crew',
  abandoned: 'abandoned',
};

const PULL_STATE: Record<NonNullable<ReleasePreparation['pullRequest']>['state'], string> = {
  open: 'open',
  merged: 'merged',
  unknown: 'state unknown',
};

/** The console's link to a request's item. */
function itemHref(subject: string): string {
  return `/?item=${encodeURIComponent(subject)}`;
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `the console answered ${response.status}`;
}

export function PrepareVersion({ repo, viewId, prepare }: { repo: string; viewId: string; prepare: ReleasePrepareOffer }) {
  const [version, setVersion] = useState(prepare.suggested);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [filed, setFiled] = useState<ReleasePreparation | null>(null);

  if (filed) return <Preparing preparing={filed} />;

  const send = () => {
    setPending(true);
    setError(null);
    void fetch(`/api/releases/${encodeURIComponent(repo)}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ viewId, version: version.trim() }),
    })
      .then(async (response) => {
        if (!response.ok) return setError(await errorOf(response));
        setFiled(((await response.json()) as { preparing: ReleasePreparation }).preparing);
      })
      .catch(() => setError('The console is not answering.'))
      .finally(() => setPending(false));
  };

  const shown = version.trim() || prepare.suggested;
  return (
    <div data-prepare className="flex flex-col gap-2 rounded-md border border-edge px-3 py-2 text-[12.5px]">
      <p className="font-medium text-body">Prepare next version</p>
      <p className="text-soft">
        The crew raises the version in {prepare.versionFile}
        {prepare.versionKey ? ` at ${prepare.versionKey}` : ''}, and everything that moves with it, through a pull request. Nothing is released until you cut it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-soft">
          Version
          <input
            data-prepare-version
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            disabled={pending}
            spellCheck={false}
            className="h-8 w-56 rounded-md border border-edge-strong bg-panel px-2 font-mono text-[12.5px] text-body"
          />
        </label>
        <button
          type="button"
          data-prepare-send
          onClick={send}
          disabled={pending || !version.trim()}
          className="h-8 rounded-md border border-edge-strong bg-panel px-3 text-[12.5px] font-medium text-body hover:border-dim disabled:opacity-60"
        >
          Send
        </button>
        {error && (
          <span role="status" data-prepare-error className="text-[12px] text-alarm">
            {error}
          </span>
        )}
      </div>
      <p data-prepare-after className="text-dim">
        Once it merges, Cut release offers {shown} after {prepare.last.version}.
      </p>
    </div>
  );
}

/** An open preparation: its request, and the issue and pull request the crew made of it. */
export function Preparing({ preparing }: { preparing: ReleasePreparation }) {
  return (
    <div data-preparing className="flex flex-col gap-1 rounded-md border border-edge px-3 py-2 text-[12.5px]">
      <p className="font-medium text-body">
        Preparing {preparing.version ?? 'the next version'}
      </p>
      <p className="flex flex-wrap gap-x-3 text-soft">
        <a data-preparing-request href={itemHref(preparing.subject)} className="text-link hover:underline">
          The request
        </a>
        <span>{STATE[preparing.state]}</span>
        {preparing.issue && (
          <a data-preparing-issue href={preparing.issue.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
            Issue #{preparing.issue.number}
          </a>
        )}
        {preparing.pullRequest && (
          <a data-preparing-pull href={preparing.pullRequest.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
            Pull request #{preparing.pullRequest.number}, {PULL_STATE[preparing.pullRequest.state]}
          </a>
        )}
        {preparing.unknown && <span data-preparing-unknown className="text-dim">State unknown: GitHub did not say, so it is counted as open</span>}
      </p>
      <p className="text-dim">Once it merges, reload this page to cut the release.</p>
    </div>
  );
}
