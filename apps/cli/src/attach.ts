/**
 * What `fleetadlc attach` says when it cannot attach, and what to do about it.
 *
 * It said `fetch failed`, `bridge returned 401` or `the attach token was
 * refused`, none of which says whether the stack is down, the CLI is not
 * trusted, or the token ran out.
 */
export type AttachAnswer = { status: number; error?: string } | 'unreachable';

export function attachFailure(step: 'bridge' | 'hostd', answer: AttachAnswer, port: number): { reason: string; hint: string } {
  if (answer === 'unreachable') {
    return { reason: `${step === 'bridge' ? 'the bridge' : 'hostd'} is not answering on port ${port}`, hint: 'start the stack: fleetadlc up' };
  }
  const said = answer.error ? `: ${answer.error}` : '';
  if (step === 'bridge') {
    if (answer.status === 401 || answer.status === 403) {
      return {
        reason: `the bridge refused to mint an attach token (${answer.status}${said})`,
        hint: 'taking over a session is an admin’s; the CLI is one through this install’s console secret, so check FLEETADLC_HOME names the install that bridge runs',
      };
    }
    return { reason: `the bridge could not mint an attach token (${answer.status}${said})`, hint: 'check the bot and session names on the task’s page in the console' };
  }
  if (answer.status === 401) {
    return { reason: `hostd refused the attach token${said}`, hint: 'a token works for a short while only: run fleetadlc attach again' };
  }
  if (answer.status === 404) {
    return { reason: `hostd has no such session${said}`, hint: 'the session may have ended; the console shows the ones still running' };
  }
  return { reason: `hostd could not attach (${answer.status}${said})`, hint: 'run fleetadlc attach again, or fleetadlc doctor' };
}

/** A refusal's status and the `error` its JSON body carries, when it has one. */
export async function answerOf(response: Response): Promise<{ status: number; error?: string }> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? { status: response.status, error: body.error } : { status: response.status };
}
