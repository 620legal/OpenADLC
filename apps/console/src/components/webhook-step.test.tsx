import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WebhookNotHeard, WebhookReady, deliverySentence, type WebhookStatus } from './webhook-step';

const NOW = Date.parse('2026-09-24T18:00:00Z');
const URL = 'https://example-tunnel.trycloudflare.com/webhooks/github';

function ready(partial: Partial<WebhookStatus> = {}): WebhookStatus {
  return {
    ready: true,
    publicUrl: 'https://example-tunnel.trycloudflare.com',
    webhookUrl: URL,
    secretStored: true,
    tunnel: { running: true, url: 'https://example-tunnel.trycloudflare.com', since: '2026-09-24T17:43:52Z', detail: '' },
    github: { url: URL, secretSet: true },
    stale: false,
    canAutomate: true,
    tunnelAvailable: true,
    detail: '',
    lastDelivery: { event: 'issue_comment', action: 'created', statusCode: 200, deliveredAt: '2026-09-24T17:58:00Z', redelivery: false },
    ...partial,
  };
}

function render(status: WebhookStatus): string {
  return renderToStaticMarkup(
    <WebhookReady status={status} busy={null} error={null} onNewAddress={() => undefined} onStop={() => undefined} now={NOW} />,
  ).replace(/<!-- -->/g, '');
}

describe('the webhook step once OpenADLC has done it', () => {
  it('offers nothing to copy, because there is nothing left to paste', () => {
    const html = render(ready());
    // The address was a copy field, which read as a task; OpenADLC wrote it onto
    // the app itself and moves it when the tunnel does.
    expect(html).not.toMatch(/copy<\/button>|>COPY</i);
    expect(html).toContain('Nothing to copy');
    expect(html).toContain(URL);
  });

  it('says what GitHub last delivered and that the bridge accepted it', () => {
    expect(render(ready())).toContain('GitHub’s last delivery — issue_comment (created), 2 min ago — was accepted (200).');
  });

  it('keeps the tunnel controls, quietly', () => {
    const html = render(ready());
    expect(html).toContain('new address');
    expect(html).toContain('take it off the internet');
    expect(render(ready({ tunnel: { running: false, url: '', since: null, detail: '' } }))).not.toContain('new address');
  });
});

describe('what GitHub’s last delivery says', () => {
  const at = '2026-09-24T17:00:00Z';

  it('is plain when nothing has been delivered yet', () => {
    expect(deliverySentence(null, NOW)).toEqual({
      text: expect.stringContaining('has not delivered anything yet'),
      tone: 'plain',
    });
  });

  it('warns when GitHub got no answer, or the signature was refused', () => {
    expect(deliverySentence({ event: 'ping', action: null, statusCode: 0, deliveredAt: at, redelivery: false }, NOW)).toEqual({
      text: 'GitHub’s last delivery — ping, 1 h ago — got no answer: nothing was listening at the address.',
      tone: 'warn',
    });
    expect(deliverySentence({ event: 'push', action: null, statusCode: 401, deliveredAt: at, redelivery: false }, NOW).text).toContain(
      'its signature did not match',
    );
    expect(deliverySentence({ event: 'push', action: null, statusCode: 502, deliveredAt: at, redelivery: false }, NOW).tone).toBe('warn');
  });
});

function renderNotHeard(status: WebhookStatus): string {
  return renderToStaticMarkup(<WebhookNotHeard status={status} checking={false} onCheck={() => undefined} />).replace(
    /<!-- -->/g,
    '',
  );
}

/**
 * Set up, and GitHub has sent nothing.
 *
 * On a real install this step said "GitHub delivers to this bridge" while
 * GitHub had never delivered a thing: the app had been created with its
 * webhook switched off, which no API can switch on. So the step says so, and
 * switching it on is a numbered step with the link.
 */
describe('the webhook step when GitHub has sent nothing', () => {
  const SETTINGS = 'https://github.com/settings/apps/fleetadlc-janedoe';
  const unheard = ready({
    ready: false,
    configured: true,
    hearing: 'silent',
    settingsUrl: SETTINGS,
    lastDelivery: null,
    unheard: [
      {
        subject: 'fleetadlc-testbed#1',
        what: 'imported',
        title: 'Document the webhook step',
        url: 'https://github.com/janedoe/fleetadlc-testbed/issues/1',
        happenedAt: '2026-09-24T17:10:00Z',
        foundAt: '2026-09-24T17:15:00Z',
      },
    ],
  });

  it('says plainly that GitHub is not sending, and names what shows it', () => {
    const html = renderNotHeard(unheard);
    expect(html).toContain('GitHub is not sending events to OpenADLC.');
    expect(html).toContain('Open the app’s settings and turn on Active under Webhook.');
    expect(html).toContain('OpenADLC found fleetadlc-testbed#1 by reading the repository; GitHub never delivered it.');
    expect(html).not.toContain('GitHub delivers to this bridge');
  });

  it('makes switching it on a numbered step, with the link, checked by the first delivery', () => {
    const html = renderNotHeard(unheard);
    expect(html).toMatch(/<ol[^>]*><li><a href="https:\/\/github\.com\/settings\/apps\/fleetadlc-janedoe" target="_blank"/);
    expect(html).toContain('Under <span class="font-medium">Webhook</span>, tick <span class="font-medium">Active</span>.');
    expect(html).toContain('Save changes');
    expect(html).toContain('when GitHub’s first delivery arrives');
  });

  it('asks for the same switch before anything shows it is off, without saying it is', () => {
    const html = renderNotHeard({ ...unheard, hearing: 'never', unheard: [] });
    expect(html).not.toContain('is not sending');
    expect(html).toContain('GitHub has not delivered anything yet');
    expect(html).toContain(`<a href="${SETTINGS}"`);
  });

  it('keeps the way to take a running tunnel down, as setting it up promised', () => {
    const html = renderToStaticMarkup(
      <WebhookNotHeard
        status={{ ...unheard, hearing: 'never' }}
        checking={false}
        onCheck={() => undefined}
        busy={null}
        error={null}
        onNewAddress={() => undefined}
        onStop={() => undefined}
      />,
    );
    expect(html).toContain('take it off the internet');
    expect(html).toContain('new address');
    expect(renderNotHeard({ ...unheard, tunnel: { running: false, url: '', since: null, detail: '' } })).not.toContain(
      'take it off the internet',
    );
  });
});
