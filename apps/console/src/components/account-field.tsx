'use client';

import { useEffect, useState } from 'react';
import { couldNotAsk, lookupTerm, useGitHubLookup } from '@/components/github-lookup';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { cn } from '@/lib/cn';
import type { InstallSettings, SettingKey } from '@/components/install-settings';

/**
 * The organization field, which checks GitHub while you type.
 *
 * A plain text box takes a typo happily, and the mistake surfaces much later —
 * when a bot cannot see a repository and nothing says why. So the account is
 * resolved while it is typed.
 *
 * It also reports whether the account is an organization or a person, which is
 * worth knowing but is not a warning: OpenADLC works the same either way. The one
 * thing an organization has that a person does not is the Triage role, so that
 * is what the note says, rather than suggesting the install is worse.
 */
export function AccountField({
  settings,
  save,
  onSaved,
}: {
  settings: InstallSettings;
  save: (key: SettingKey, value: string) => Promise<void>;
  onSaved?: () => void;
}) {
  const stored = settings.organization;
  const [value, setValue] = useState(stored);
  const { lookup, looking } = useGitHubLookup(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setValue(stored), [stored]);

  // What is saved is what the lookup checked: without the `@`, and in
  // GitHub's own casing once GitHub found it. "@acme" used to be saved as
  // typed, though the lookup had shown acme: the org check then asked GitHub
  // for "@acme", failed, and the app was created on the person's own account.
  const normalized = lookupTerm(value);
  const dirty = normalized !== stored;

  // Only a match for what is in the field, as Approvers does: "acme" is not
  // found while the field says "acme-labs".
  const found = lookup?.exact?.login.toLowerCase() === normalized.toLowerCase() ? lookup.exact : null;

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      await save('organization', found?.login ?? normalized);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md">
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-dim">organization or account</span>
        <input
          type="text"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && dirty) void commit();
          }}
          placeholder="your-org"
          className="mt-1.5 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
        />
      </label>

      <div className="mt-2 min-h-[1.5rem]">
        {looking && value.trim().length >= 2 && (
          <p className="text-[11.5px] text-dim">looking on GitHub…</p>
        )}

        {!looking && found && (
          <div className="flex items-center gap-2">
            {found.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={found.avatarUrl} alt="" className="size-5 rounded-full" />
            )}
            <a
              href={found.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[12.5px] text-body hover:underline"
            >
              {found.login}
            </a>
            <Chip tone={found.type === 'Organization' ? 'signal' : 'neutral'}>
              {found.type === 'Organization' ? 'organization' : 'personal account'}
            </Chip>
          </div>
        )}

        {!looking && lookup && !found && lookup.suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] text-dim">no exact match — did you mean:</span>
            {lookup.suggestions.map((account) => (
              <button
                key={account.login}
                type="button"
                onClick={() => setValue(account.login)}
                className="rounded-md border border-edge-strong px-1.5 py-0.5 text-[11.5px] text-soft hover:text-body"
              >
                {account.login}
              </button>
            ))}
          </div>
        )}

        {!looking && lookup && !found && lookup.suggestions.length === 0 && !couldNotAsk(lookup) && (
          // Not an error: they may be about to create it.
          <p className="text-[11.5px] text-dim">
            nothing on GitHub called “{value.trim()}” yet
          </p>
        )}

        {!looking && lookup?.rateLimited && (
          <p className="text-[11.5px] text-dim">GitHub is rate-limiting the check; the name still saves</p>
        )}
        {!looking && lookup?.unavailable && (
          <p className="text-[11.5px] text-dim">GitHub did not answer the check; the name still saves</p>
        )}
      </div>

      {found?.type === 'User' && (
        // Informational, not a warning. OpenADLC runs identically on a repository
        // owned by a person; the single difference is a role GitHub only offers
        // on an organization, and OpenADLC's own gates cover it either way.
        <p className="mt-2 rounded-md border border-edge bg-panel/40 p-2.5 text-[11.5px] leading-relaxed text-muted">
          OpenADLC works the same on a repository owned by a person. One difference worth knowing: GitHub offers the
          Triage role only on an organization, so intake and the automation account will hold <span className="text-soft">write</span>
          {' '}here, and OpenADLC’s own gates are what keep them from pushing.
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => void commit()} disabled={!dirty || busy}>
          {busy ? 'saving…' : dirty ? 'save' : 'saved'}
        </Button>
        {error && <span className={cn('text-[11px]', 'text-attention')}>{error}</span>}
      </div>
    </div>
  );
}
