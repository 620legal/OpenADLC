import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeviceCode } from './device-code';

describe('a device code', () => {
  it('links to the page it is entered on, the one GitHub named, opening it in a new tab', () => {
    const html = renderToStaticMarkup(<DeviceCode code="BC61-4B23" url="https://github.com/login/device" />);
    // It was a sentence with the address in it, as text nobody could click.
    expect(html).toMatch(/<a href="https:\/\/github.com\/login\/device" target="_blank"[^>]*>Copy and open github.com\/login\/device/);
    expect(html).toContain('BC61-4B23');
  });

  it('links to GitHub’s device page when GitHub’s answer named none', () => {
    expect(renderToStaticMarkup(<DeviceCode code="BC61-4B23" />)).toContain('href="https://github.com/login/device"');
  });
});
