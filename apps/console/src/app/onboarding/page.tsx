import { BridgeDown } from '@/components/bridge-down';
import { OnboardingView } from '@/components/onboarding-view';
import { AdminsOnly } from '@/components/not-a-user';
import { BRIDGE_URL, readMe } from '@/lib/api';
import { bridgeAnswered } from '@/lib/bridge-answered';
import type { OnboardingData } from '@/components/onboarding-view';
import { identityHeaders } from '@/lib/identity';
import type { AppChecks } from '@/components/app-checks';
import { ENGINES_WAIT_MS, accountsFrom, crewFromEngines, jsonWithin } from '@/lib/model-onboarding';
import type { RestoreState } from '@/lib/backup';
import { BRIDGE_NOT_ANSWERING } from '@/lib/reach';
import type { InstallSettings } from '@/components/install-settings';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; step?: string }>;
}) {
  // `step` is where a link in the walkthrough's header points. Followed before
  // the page's script has run, or into a new tab, it arrives here, and the
  // walkthrough opens on that step rather than the first one undone.
  // The walkthrough sets the install up, which is an admin's; the bridge
  // refuses a user every read it makes.
  const me = await readMe();
  if (me?.known && me.role !== 'admin')
    return <AdminsOnly email={me.email} identityMode={me.identityMode} what="Setting up needs" doing="sets the install up" />;
  // A failed app exchange is said on app-created/page.tsx itself: nothing in
  // this address is shown as the console's own words.
  const { email = '', step } = await searchParams;

  // Rendered on the server so the walkthrough is there on first paint rather
  // than after a round trip, and so it reads without JavaScript.
  //
  // The checks come with it, rather than arriving a moment later from the
  // browser. Which step this opens on is decided once, from what is known at
  // that moment — so anything learned afterwards cannot change it, and a page
  // that opened on the wrong step stays on the wrong step.
  const headers = await identityHeaders();
  // Whether a backup can be restored here, which decides the first step.
  // Asked alongside the rest; a bridge that cannot say leaves the step out.
  const restoring = fetch(`${BRIDGE_URL}/v1/restore`, { cache: 'no-store', headers })
    .then((response) => (response.ok ? (response.json() as Promise<RestoreState>) : null))
    .catch(() => null);
  const [initial, checks, accountsBody, enginesBody, settings] = await Promise.all([
    // An answer with an error is kept, not read as no answer: a 401 from a
    // bridge behind IAP, or a 500 with the database down, said "cannot reach
    // the bridge … run fleetadlc up" over a bridge that was up.
    fetch(`${BRIDGE_URL}/v1/onboarding?email=${encodeURIComponent(email)}`, {
      cache: 'no-store',
      headers,
    })
      .then(async (response) => (response.ok ? ((await response.json()) as OnboardingData) : await bridgeAnswered('/v1/onboarding', response)))
      .catch(() => new Error(BRIDGE_NOT_ANSWERING)),
    fetch(`${BRIDGE_URL}/v1/app-checks`, { cache: 'no-store', headers })
      .then((response) => (response.ok ? (response.json() as Promise<AppChecks>) : null))
      .catch(() => null),
    fetch(`${BRIDGE_URL}/v1/model-accounts`, { cache: 'no-store', headers })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
    // Bounded: this one waits on hostd's readiness probe. A hostd that does
    // not answer leaves the crew unknown, which the assignment step reads as
    // not done, and the page still renders.
    jsonWithin(`${BRIDGE_URL}/v1/engines`, { cache: 'no-store', headers }, ENGINES_WAIT_MS),
    // The Owner and App steps are drawn from these. Read in the browser alone,
    // they were empty in the first paint, and stayed empty if that read failed.
    fetch(`${BRIDGE_URL}/v1/install`, { cache: 'no-store', headers })
      .then((response) => (response.ok ? (response.json() as Promise<InstallSettings>) : null))
      .catch(() => null),
  ]);

  // The walkthrough reports what is already true on GitHub, so it needs the bridge.
  if (initial instanceof Error) return <BridgeDown error={initial} />;

  // The stored address, when the URL carried none: each seat's suggested email
  // is built from it.
  return (
    <OnboardingView
      initialEmail={email || initial.operatorEmail || ''}
      initialData={initial}
      initialChecks={checks}
      initialAccounts={accountsBody ? accountsFrom(accountsBody) : null}
      initialCrew={enginesBody ? crewFromEngines(enginesBody) : null}
      initialStep={typeof step === 'string' ? step : null}
      initialRestore={await restoring}
      initialSettings={settings}
    />
  );
}
