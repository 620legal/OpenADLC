import Link from 'next/link';
import type { IdentityMode } from '@/lib/api';

/**
 * The one page someone sees whom IAP let in but this install does not know:
 * every bridge route refuses them (`not-a-user`), so there is nothing else to
 * draw. It names the admins, since the person has no other way to find out
 * whom to ask.
 */
export function NotAUser({ email, admins }: { email: string; admins: readonly string[] }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <h1 className="text-lg font-semibold">Ask an admin to add you</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        You’re signed in as <span className="font-mono text-soft">{email}</span>, which this install doesn’t know. Ask an admin to add
        you in Settings → Users.
      </p>
      {admins.length > 0 && (
        <div className="mt-4 text-[13px]">
          <p className="text-soft">{admins.length === 1 ? 'The admin is' : 'The admins are'}</p>
          <ul aria-label="Admins" className="mt-1 flex flex-col gap-0.5">
            {admins.map((admin) => (
              <li key={admin}>
                <a href={`mailto:${admin}`} className="font-mono text-link hover:underline">
                  {admin}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

/**
 * What a cloud install with no admin shows everyone (`no-admin`): nobody was
 * named in `admin_emails` or among the console's IAP members, so nobody was
 * made the first admin, and nobody can be until the operator names one.
 */
export function NoAdmin({ email }: { email: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <h1 className="text-lg font-semibold">No admin is configured</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        You’re signed in as <span className="font-mono text-soft">{email}</span>, but this install has no admin yet, so nobody can use it.
        Whoever runs it sets <span className="font-mono text-soft">admin_emails</span> (the bridge’s{' '}
        <span className="font-mono text-soft">FLEETADLC_ADMIN_EMAILS</span>) to the first admins’ emails and deploys again.
      </p>
    </main>
  );
}

/**
 * What a user sees on a page that is an admin's: Settings, the walkthrough.
 *
 * A local console sends one identity on every request and can send no other,
 * so once that identity is a user nobody can open Settings to undo it. The
 * way back is outside the console, and the page says what it is.
 */
export function AdminsOnly({
  email,
  what,
  doing,
  identityMode,
}: {
  email: string;
  what: string;
  doing: string;
  identityMode?: IdentityMode;
}) {
  const back = (
    <Link href="/?board=1" className="text-link hover:underline">
      Back to the board
    </Link>
  );
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <h1 className="text-lg font-semibold">{what} an admin</h1>
      {identityMode === 'local' ? (
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          This console signs in as <span className="font-mono text-soft">{email}</span>, a user of this install, and sends that one
          identity on every request; an admin {doing}. To get Settings back, set{' '}
          <span className="font-mono text-soft">FLEETADLC_IDENTITY</span> to an admin’s address and run{' '}
          <span className="font-mono text-soft">fleetadlc up</span> again. {back}
        </p>
      ) : (
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          You’re signed in as <span className="font-mono text-soft">{email}</span>, a user of this install. Users file requests, answer
          the crew and read the board; an admin {doing}. {back}
        </p>
      )}
    </main>
  );
}
