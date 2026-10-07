import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SeatSignup } from './create-account';

/**
 * Making a crew account: the address suggested is a tag of the operator's own
 * mailbox, and GitHub writes the crew's merged pull requests with the
 * account's default commit email, so the step says to keep it private.
 */
describe('the steps to make a crew account', () => {
  const html = renderToStaticMarkup(
    <SeatSignup
      account={{
        seat: 'builder',
        label: 'builder',
        suggestedLogin: 'exampleco-builder',
        suggestedEmail: 'janedoe+fleetadlc-builder@example.com',
        connectedLogin: null,
      }}
      signupUrl="https://github.com/signup"
      emailSettingsUrl="https://github.com/settings/emails"
      connect={<span>connect it here</span>}
    />,
  );

  it('says to keep the new account’s email private, with a link to where that is set', () => {
    expect(html).toContain('Keep my email addresses private');
    expect(html).toContain('Block command line pushes that expose my email');
    expect(html).toContain('href="https://github.com/settings/emails"');
  });

  it('says it in step 3, before connecting the account', () => {
    expect(html.indexOf('Keep my email addresses private')).toBeLessThan(html.indexOf('connect it here'));
    expect(html.indexOf('Keep my email addresses private')).toBeGreaterThan(html.indexOf('Sign up with these'));
  });
});
