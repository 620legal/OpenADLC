'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CLOUDFLARED_INSTALL } from '@/components/webhook-step';

interface ManifestResponse {
  postUrl: string;
  manifest: Record<string, unknown>;
  /**
   * What the app's webhook will have for an address: `have` one, a `tunnel`
   * OpenADLC raises first, or `none` — and then GitHub creates it switched off.
   * Absent from an older bridge.
   */
  address?: 'have' | 'tunnel' | 'none';
}

/** What the page says will happen, for what the webhook will have. */
export function createAppNote(address: ManifestResponse['address']): string {
  // App names are unique across GitHub. The manifest proposes one with a
  // random end, and a refusal is still fixed on GitHub's page: nothing here
  // reads the name back.
  const back =
    'Press Create, and it sends the client id, the private key and the webhook secret straight back here. If GitHub says the name is taken or too long, change it on GitHub’s page: OpenADLC keeps the app’s id and key, not its name.';
  switch (address) {
    case 'have':
      return `GitHub will show you exactly what it is about to create — every permission and event is already filled in, and the webhook points at this bridge. ${back}`;
    case 'tunnel':
      return `OpenADLC first raises a tunnel for this bridge — one route on the internet, the one GitHub posts to, which you can take down from the webhook step — so that GitHub creates the app with its webhook switched on. Then GitHub shows you exactly what it is about to create, every permission and event filled in. ${back}`;
    case 'none':
      return `This bridge has no public address yet, so GitHub will create the app with its webhook switched off, and the webhook step will show you how to switch it on. With cloudflared installed (${CLOUDFLARED_INSTALL}), OpenADLC raises a tunnel first and the app starts with it on. ${back}`;
    default:
      return `GitHub will show you exactly what it is about to create — every permission and event is already filled in. ${back}`;
  }
}

/** The bridge's reason, out of the JSON it answers with when it can. */
function reasonFrom(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return text.trim().slice(0, 300) || null;
  }
}

/**
 * Creating the OpenADLC app in one click.
 *
 * Registering it by hand is a dozen separate correctnesses — every permission
 * and event, a payload URL, a generated key and a generated secret — each copied
 * between two browser tabs, and two of them pasted back into OpenADLC afterwards.
 *
 * A manifest replaces all of that. GitHub renders its own create page with
 * everything already set, and redirects back with a code worth the `client_id`,
 * the private key and the webhook secret. Nothing is copied anywhere.
 *
 * It has to be a form POST rather than a link, because the manifest travels as a
 * form field. Hence the hidden form and the button that submits it.
 *
 * The app's webhook starts switched on only if the manifest gives it an
 * address, and nothing but a person on the app's settings page can switch it
 * on afterwards. So when this bridge has no address and can raise a tunnel,
 * the click raises one first and the manifest carries it. The click then waits
 * on cloudflared, which is why the form goes in this tab: a tab opened after a
 * wait is a popup, and a browser blocks it.
 */
export function CreateApp({ organization }: { organization: string | null }) {
  const [data, setData] = useState<ManifestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/app-manifest', { cache: 'no-store' });
        if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
        setData((await response.json()) as ManifestResponse);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'could not build the manifest');
      }
    })();
  }, [organization]);

  /**
   * Posts a manifest to GitHub. Written into the form here rather than through
   * state: React would render it after this returns, and the form goes now.
   */
  function post(prepared: ManifestResponse): void {
    const target = form.current;
    if (!target) return;
    target.action = prepared.postUrl;
    const field = target.elements.namedItem('manifest');
    if (field instanceof HTMLInputElement) field.value = JSON.stringify(prepared.manifest);
    target.submit();
  }

  /**
   * Every create goes through `prepare`, whatever the address: it gives the
   * `state` GitHub sends back beside the code, and the bridge exchanges no code
   * without one it issued. A code alone, sent to the app-created page by a
   * link, replaced the install's app. Without an address, it raises no tunnel.
   */
  async function create(options: { withoutAddress?: boolean } = {}): Promise<void> {
    if (!data) return;
    setPreparing(true);
    setPrepareError(null);
    try {
      const response = await fetch('/api/app-manifest/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options.withoutAddress ? { withoutAddress: true } : {}),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(reasonFrom(text) ?? `the bridge answered ${response.status}`);
      post(JSON.parse(text) as ManifestResponse);
    } catch (cause) {
      setPrepareError(cause instanceof Error ? cause.message : 'could not give this bridge an address');
      setPreparing(false);
    }
  }

  if (error) return <p className="text-[12px] text-attention">{error}</p>;
  if (!data) return <p className="text-[12px] text-dim">preparing…</p>;

  return (
    <div>
      <form ref={form} method="post" action={data.postUrl}>
        <input type="hidden" name="manifest" value={JSON.stringify(data.manifest)} />
      </form>
      <Button variant="primary" onClick={() => void create()} disabled={preparing}>
        {preparing ? (data.address === 'tunnel' ? 'giving this bridge an address…' : 'preparing…') : 'create the OpenADLC app on GitHub'}
      </Button>
      <p className="mt-2 max-w-lg text-[11.5px] leading-relaxed text-muted">{createAppNote(data.address)}</p>
      {prepareError && (
        <div className="mt-2 max-w-lg space-y-1.5">
          <p className="text-[12px] text-attention">{prepareError}</p>
          <button
            type="button"
            className="text-[12px] text-muted underline underline-offset-2 hover:text-body"
            onClick={() => void create({ withoutAddress: true })}
          >
            create it without an address — its webhook starts switched off
          </button>
        </div>
      )}
    </div>
  );
}
