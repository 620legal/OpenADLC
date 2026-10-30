import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GitHubLinkView } from './github-link-card';

/** "Your GitHub account": linked by the person's own sign-in, and unlinked by them. */

const quiet = { error: null, pending: false, onLink: () => undefined, onUnlink: () => undefined };

describe('your GitHub account', () => {
  it('offers to link an account when none is, and shows the code to enter once asked', () => {
    const none = renderToStaticMarkup(<GitHubLinkView linked={null} flow={null} {...quiet} />);
    expect(none).toContain('Link your GitHub account');
    const asked = renderToStaticMarkup(
      <GitHubLinkView linked={null} flow={{ flowId: 'f', userCode: 'WXYZ-0001', verificationUri: 'https://github.com/login/device' }} {...quiet} />,
    );
    expect(asked).toContain('WXYZ-0001');
    expect(asked).not.toContain('Link your GitHub account');
    expect(asked).toMatch(/keeps your login and account id, not the sign-in/);
  });

  it('names the linked account, with a way to unlink it', () => {
    const html = renderToStaticMarkup(<GitHubLinkView linked="orzelig" flow={null} {...quiet} />);
    expect(html).toContain('@orzelig');
    expect(html).toMatch(/<button[^>]*>Unlink<\/button>/);
  });

  it('says why a link failed', () => {
    expect(renderToStaticMarkup(<GitHubLinkView linked={null} flow={null} {...quiet} error="@fleet-atlas-orzelig is an account the crew uses" />)).toContain(
      'account the crew uses',
    );
  });
});
