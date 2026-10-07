'use client';

import { useEffect, useState } from 'react';
import { ExternalIcon } from '@/components/icons';
import { SettingsPart } from '@/components/settings-sections';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { accountLine, visibilityLine, type AccountView, type AppView, type InstallationsView } from '@/lib/app-reach';
import { cn } from '@/lib/cn';
import { poll } from '@/lib/reach';

/**
 * Settings' GitHub App: whose the app is, who can install it, and each account
 * it is installed on — with the page on GitHub where each of those is changed.
 *
 * OpenADLC works only in repositories the app reaches, and the app is installed
 * on each account on its own. Adding a repository of another account used to
 * be possible with nothing saying so, and nothing said either that the
 * walkthrough makes the app private, which GitHub installs only on the account
 * that owns it. Making it public used to sit beside the app's name. That cannot
 * be undone while another account has it installed, and it lets any GitHub
 * account install it, which a one-account install gains nothing from. The
 * choice is inside "Install on another account", the only place it is needed.
 * Each account OpenADLC works in is listed here, installed or not, with what to
 * do where it is not; GitHub's own pages do the rest.
 *
 * Self-contained, so the page mounts it with one line: it reads
 * `/api/github/installations` itself, unless the page already read it for the
 * first paint (`initial`).
 */
export function GitHubAppCard({ initial = null }: { initial?: InstallationsView | null }) {
  const [view, setView] = useState<InstallationsView | null>(initial);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initial) return;
    void poll<InstallationsView>('/api/github/installations').then((answer) => {
      if (answer) setView(answer);
      else setFailed(true);
    });
  }, [initial]);

  return (
    <SettingsPart
      id="github-app"
      title="GitHub App"
      line="OpenADLC works only in the repositories the app reaches."
      action={
        view?.app ? (
          <a href={view.app.settingsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-link hover:underline">
            Open its settings
            <ExternalIcon size={11} />
          </a>
        ) : undefined
      }
    >
      {view ? (
        <GitHubAppPanel view={view} />
      ) : (
        <p className="text-[12.5px] text-muted">{failed ? 'The bridge did not say where the app is installed just now. Reload to try again.' : 'Asking GitHub where the app is installed…'}</p>
      )}
    </SettingsPart>
  );
}

/** The section, drawn from what the bridge said. `GitHubAppCard` reads it. */
export function GitHubAppPanel({ view }: { view: InstallationsView }) {
  const { app } = view;
  if (!app) {
    return <p className="border-t border-well pt-3 text-[12.5px] text-muted">{sentence(view.reason || 'The app is not set up yet')}</p>;
  }
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-well py-3">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-semibold text-body">
            {app.name}
            <span className="font-normal text-muted">
              {' '}
              · owned by {app.owner.login} · {app.visibility === 'unknown' ? 'public or private, not known' : app.visibility}
            </span>
          </span>
          <span className="text-[12px] leading-snug text-muted">{visibilityLine(app)}</span>
        </div>
      </div>

      <p className="border-t border-well pb-1 pt-3 text-[11px] uppercase tracking-wider text-dim">Installed on</p>
      <ul aria-label="Where the app is installed" className="flex flex-col">
        {view.accounts.map((account) => (
          <AccountRow key={account.login} account={account} />
        ))}
      </ul>

      <div className="border-t border-well pb-0.5 pt-3">
        <InstallOnAnotherAccount app={app} />
      </div>
    </div>
  );
}

/** One account: how the app is installed there, what OpenADLC works in there, and where either is changed. */
function AccountRow({ account }: { account: AccountView }) {
  const works = account.repositories.length > 0 ? `OpenADLC works in ${account.repositories.join(', ')}` : 'OpenADLC works in none of its repositories';
  const link = account.installation?.settingsUrl
    ? { label: account.installation.suspended ? 'Unsuspend it' : 'Choose repositories', url: account.installation.settingsUrl }
    : (account.fix?.action ?? { label: `Install on ${account.login}`, url: account.installUrl });
  return (
    <li className="flex flex-col gap-1.5 border-b border-well py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px]">
            <span className="font-medium text-body">{account.login}</span>
            <span className={cn(account.installation && !account.installation.suspended ? 'text-muted' : 'text-attention')}>
              {' '}
              · {accountLine(account)}
            </span>
          </span>
          <span className="text-[12px] text-muted">{works}</span>
        </span>
        <GitHubLink href={link.url} quiet={!account.fix}>
          {link.label}
        </GitHubLink>
      </div>
      {account.fix && (
        <p className="rounded-md bg-surface px-2.5 py-2 text-[12px] leading-normal text-soft">
          <span className="font-medium text-body">{account.fix.title}.</span> {account.fix.detail}
        </p>
      )}
    </li>
  );
}

/**
 * Installing elsewhere is the one reason to change who can install the app.
 * A public app cannot be made private again while another account has it
 * installed, and any GitHub account can then install it, so a private app
 * explains that here instead of linking straight to GitHub. A public app
 * already can be installed by any account, and goes straight there.
 */
function InstallOnAnotherAccount({ app }: { app: AppView }) {
  if (app.visibility !== 'private') {
    return (
      <GitHubLink href={app.installUrl} quiet>
        Install on another account
      </GitHubLink>
    );
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={cn(linkClass, quietLinkClass)}>
          Install on another account
        </button>
      </DialogTrigger>
      <DialogContent>
        <InstallElsewhereDialog app={app} />
      </DialogContent>
    </Dialog>
  );
}

/** What the dialog says: why a private app cannot go elsewhere, and what changing that costs. */
export function InstallElsewhereDialog({ app }: { app: AppView }) {
  const owner = app.owner.login;
  const person = app.owner.type === 'User';
  return (
    <>
      <DialogTitle>Install on another account</DialogTitle>
      <DialogDescription>
        GitHub installs a private app only on the account that owns it, so {owner}’s app cannot go on another account yet.
      </DialogDescription>
      {person && (
        <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
          For an organization, transfer the app to it. {owner} transfers it in the app’s{' '}
          <a href={app.advancedUrl} target="_blank" rel="noreferrer" className="text-link hover:underline">
            Advanced settings
          </a>{' '}
          (“Transfer ownership”), and an owner of the organization accepts. It keeps its id and client id, so nothing in OpenADLC
          changes, and it stays private to the organization. A repository still under {owner} has to move to the organization
          too. If it cannot, make the app public instead of transferring it, which lets anyone on GitHub install it.
        </p>
      )}
      <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
        {person ? 'Otherwise, make the app public.' : 'Make the app public to install it on another account.'} Any GitHub account can
        then install it, and it cannot be made private again while another account has it installed. An installer grants access only
        to their own repositories, and OpenADLC acts only where it works in a repository.
      </p>
      {/* Both links open GitHub in a new tab and leave this open; on a phone the
          dialog is nearly the whole screen and there is no Esc, so it closes here. */}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <DialogClose className={cn(linkClass, quietLinkClass, 'mr-auto')}>Close</DialogClose>
        <GitHubLink href={app.advancedUrl}>Make the app public</GitHubLink>
        <GitHubLink href={app.installUrl} quiet>
          Install on another account
        </GitHubLink>
      </div>
    </>
  );
}

const linkClass =
  'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link md:h-7';
const quietLinkClass = 'border border-edge-strong text-soft hover:text-body';

function GitHubLink({ href, quiet = false, children }: { href: string; quiet?: boolean; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(linkClass, quiet ? quietLinkClass : 'bg-body font-medium text-surface hover:bg-soft')}
    >
      {children}
      <ExternalIcon size={11} />
    </a>
  );
}

/** The bridge's reason as a sentence: capitalised, with its full stop. */
function sentence(reason: string): string {
  const said = reason.charAt(0).toUpperCase() + reason.slice(1);
  return said.endsWith('.') ? said : `${said}.`;
}
