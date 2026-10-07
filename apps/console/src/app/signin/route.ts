import { SESSION_COOKIE, SESSION_LIFETIME_SECONDS, SIGN_IN_ADVICE, sessionValue, validSignInToken } from '@/lib/sign-in';

/**
 * Where the link `fleetadlc up` and `fleetadlc console-link` print lands. A
 * valid token becomes a session cookie and the board; anything else is a page
 * saying how to get a link, answered 200 because the CLI's health probe asks
 * for this path and `/` now refuses a caller that has not signed in.
 *
 * SameSite=Lax, not Strict: GitHub returns from creating the app by a
 * top-level navigation to `/onboarding/app-created`, and a Strict cookie is
 * not sent on that, so onboarding would stop there.
 */
// Per request: the answer depends on the token and on the secret the console runs with.
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.FLEETADLC_CONSOLE_SECRET ?? '';
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';

  if (secret && token && (await validSignInToken(secret, token))) {
    const secure = url.protocol === 'https:' || request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
    const cookie = [
      `${SESSION_COOKIE}=${await sessionValue(secret)}`,
      'Path=/',
      `Max-Age=${SESSION_LIFETIME_SECONDS}`,
      'HttpOnly',
      'SameSite=Lax',
      ...(secure ? ['Secure'] : []),
    ].join('; ');
    // Relative, so the browser stays on the name it opened the link under.
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store' } });
  }

  const said = token ? 'That sign-in link is not valid here, or it has expired. A link works for an hour.' : '';
  const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to OpenADLC</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.25rem">Sign in to OpenADLC</h1>
${said ? `<p>${said}</p>\n` : ''}<p>${SIGN_IN_ADVICE.replace(/`([^`]+)`/g, '<code>$1</code>')}</p>
</body>
</html>
`;
  return new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
