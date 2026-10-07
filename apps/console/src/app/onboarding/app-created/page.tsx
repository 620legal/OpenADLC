import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BRIDGE_URL } from '@/lib/api';
import { identityHeaders } from '@/lib/identity';
import { yourAppsUrl } from '../../../../../../packages/shared/src/onboarding';

/**
 * The bridge's reason, out of the JSON it answers with. The whole body went
 * into the address before, `{"error":…}` and all, and the walkthrough showed
 * none of it. As `reasonFrom` in components/create-app.tsx reads it.
 */
function reasonFrom(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Where GitHub sends somebody back after the app is created.
 *
 * The exchange happens here, on the server, for the same reason the device flow
 * polls in the bridge: the reply carries a private key and a webhook secret, and
 * neither should pass through a browser.
 *
 * The code is good for one hour and once only. A created app goes on to the
 * walkthrough. One that could not be set up is said here, from the bridge's
 * own answer: it went to the walkthrough as `?app=failed&detail=…`, and any
 * link could then put any text in the console's own alert.
 *
 * A code is exchanged only with the `state` the bridge issued when create was
 * pressed, which GitHub sends back beside it. This page runs on a GET, so any
 * link could send a browser here: with a code alone, an app an attacker made
 * replaced the install's app, key and webhook secret.
 */
export default async function AppCreated({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; state?: string }>;
}) {
  const { code, state } = await searchParams;
  if (!code) return notHandedOver(null);
  if (!state) {
    return notHandedOver('GitHub sent back no state, so this was not a create started here; press create again on the onboarding page');
  }

  const response = await fetch(`${BRIDGE_URL}/v1/app-manifest/exchange`, {
    method: 'POST',
    cache: 'no-store',
    // The person's identity, like every other call to the bridge. This one sent
    // the constant 'console', which a bridge that verifies IAP refuses: behind
    // IAP, creating the app came back to "failed" and the new app's key was
    // never stored, so the walkthrough kept pointing at the app it replaced.
    headers: { 'content-type': 'application/json', ...(await identityHeaders()) },
    body: JSON.stringify({ code, state }),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error('unknown error')));

  // A bridge that does not answer is said, as a refusal is, rather than as
  // Next's "Application error". Caught on the fetch alone: redirect() works by
  // throwing, and a catch around it would swallow it.
  if (response instanceof Error) return notHandedOver(`the bridge did not answer: ${response.message}`);
  if (!response.ok) return notHandedOver(reasonFrom(await response.text().catch(() => '')) ?? `the bridge answered ${response.status}`);

  const created = (await response.json()) as { slug: string | null };
  redirect(`/onboarding?app=created&slug=${encodeURIComponent(created.slug ?? '')}`);
}

/** Where the install's apps are listed on GitHub: the walkthrough's own link, or the personal account's. */
async function yourApps(): Promise<string> {
  try {
    const response = await fetch(`${BRIDGE_URL}/v1/onboarding`, { cache: 'no-store', headers: await identityHeaders() });
    const body = response.ok ? ((await response.json()) as { links?: { yourApps?: string } }) : null;
    return body?.links?.yourApps ?? yourAppsUrl(null);
  } catch {
    return yourAppsUrl(null);
  }
}

/**
 * Why the app GitHub was asked for is not set up, with the way back.
 *
 * GitHub has made the app by the time it sends somebody back, so making it
 * again — the obvious thing to do on a step still undone, with no reason
 * given — left a second app on GitHub, and a third. `reason` is the bridge's,
 * or this page's own; null when GitHub sent no code.
 */
async function notHandedOver(reason: string | null) {
  const apps = await yourApps();
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <div role="alert" className="rounded-md border border-alarm/35 bg-alarm/5 p-3 text-[12.5px] leading-relaxed text-body">
        <h1 className="font-semibold">GitHub did not hand over the new app</h1>
        <p className="mt-1">
          {reason === null
            ? 'GitHub sent no code back, so OpenADLC could not collect the app’s keys.'
            : `OpenADLC could not collect the app’s keys: ${reason.trim().replace(/\.$/, '') || 'the bridge gave no reason'}.`}
        </p>
        <p className="mt-1 text-muted">
          GitHub may have created it anyway. If it shows under{' '}
          <a href={apps} target="_blank" rel="noreferrer" className="text-link hover:underline">
            your apps on GitHub ↗
          </a>
          , reuse it on the app step (“already have an OpenADLC app?”); otherwise create it again there.
        </p>
      </div>
      <Link href="/onboarding?step=app" className="mt-4 text-[13px] text-link hover:underline">
        Back to the app step
      </Link>
    </main>
  );
}
