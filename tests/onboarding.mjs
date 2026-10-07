#!/usr/bin/env node
/**
 * Onboarding is what a new install meets first, and it makes claims about
 * GitHub, so these checks are about whether it tells the truth: what exists,
 * what is connected, what is left, and that the console can drive the device
 * flow without the refresh token ever reaching the browser.
 *
 *   tests/scratch.sh up && eval "$(tests/scratch.sh env)" && node tests/onboarding.mjs
 */
import { createHmac } from 'node:crypto';
import { bots, closePool, credentials, query, waitForDatabase } from '@fleetadlc/db';
import { consoleSecretRef, getSecretStore } from '@fleetadlc/github';
import { ONBOARDING_STEPS, STEP_TITLES as SHARED_STEP_TITLES } from '@fleetadlc/shared';
import { refuseARealInstall } from './scratch-only.mjs';

// Before anything else is read or written: see scratch-only.mjs.
await refuseARealInstall();

/**
 * The walkthrough's titles, from the module the bridge renders them from. The
 * titles themselves are pinned in packages/shared/src/onboarding.test.ts; what
 * this proves is that every one of them reached the page.
 */
const STEP_TITLES = ONBOARDING_STEPS.map((step) => SHARED_STEP_TITLES[step]);

const BRIDGE = process.env.FLEETADLC_BRIDGE_URL ?? 'http://127.0.0.1:47311';
const CONSOLE = process.env.FLEETADLC_CONSOLE_URL ?? 'http://127.0.0.1:47300';
// `/v1` is served only to the console and the CLI, which hold this; the suite reads it as they do.
const CONSOLE_SECRET = (await getSecretStore().get(consoleSecretRef())) ?? '';
const AS_CONSOLE = { 'x-fleetadlc-console-secret': CONSOLE_SECRET };

/**
 * Signs in to the console the way a person does, with the link
 * `fleetadlc console-link` prints, and returns the cookie it sets.
 */
async function signIn() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${exp}.${createHmac('sha256', CONSOLE_SECRET).update(`fleetadlc-console-sign-in:${exp}`).digest('hex')}`;
  const response = await fetch(`${CONSOLE}/signin?token=${token}`, { redirect: 'manual' });
  return { status: response.status, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] };
}

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function view(email = 'owner@example.test') {
  const response = await fetch(`${BRIDGE}/v1/onboarding?email=${encodeURIComponent(email)}`, { headers: AS_CONSOLE });
  if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
  return response.json();
}

async function main() {
  await waitForDatabase();
  console.log('\nonboarding checks\n');

  const data = await view();

  // ------------------------------------------------------------- the steps
  // Against the shared list rather than a number, so adding a step to the
  // install is one edit and not two.
  check(
    'names every step of the install',
    data.steps.length === ONBOARDING_STEPS.length,
    data.steps.map((s) => s.step).join(', '),
  );
  check(
    'protecting the repositories is one of them',
    data.steps.some((step) => step.step === 'protect'),
    // On a personal repository the rulesets are the only containment there is,
    // so an install that follows the walkthrough has to be walked through them.
    data.steps.find((step) => step.step === 'protect')?.detail ?? 'absent',
  );
  check(
    'accepting the repository invitations is said on the access step',
    /invitation/i.test(data.steps.find((step) => step.step === 'access')?.detail ?? ''),
    // A connected bot with an unaccepted invitation has a valid token and still
    // cannot push, which is the failure the access step exists to prevent.
    data.steps.find((step) => step.step === 'access')?.detail ?? 'absent',
  );
  check(
    'says, per bot, whether it is actually in the repository yet',
    // Connected is not the same as able to work: a bot with an unaccepted
    // invitation holds a valid token and 404s on every repository call.
    data.bots.every((bot) => bot.inRepository === null || typeof bot.inRepository === 'boolean'),
    `${data.bots.filter((bot) => bot.inRepository === true).length} of ${data.bots.length} are in`,
  );
  check(
    'asks the operator for the permission without which none of that works',
    data.appPermissions.some((entry) => entry.permission === 'Administration'),
    // `403 Resource not accessible by integration` reads as a limit of app
    // tokens; it is this permission missing, and GitHub says so in a header.
    data.appPermissions.find((entry) => entry.permission === 'Administration')?.why ?? 'absent',
  );
  check(
    'every step says what it is for',
    data.steps.every((step) => step.title.length > 0 && step.detail.length > 0),
  );
  check('knows whether the install is finished', typeof data.complete === 'boolean', `complete: ${data.complete}`);

  // -------------------------------------------------------------- the crew
  const crew = await bots.listBots();
  check('lists one card per bot', data.bots.length === crew.length, `${data.bots.length} bots`);

  const intake = data.bots.find((bot) => bot.role === 'intake');
  const automation = data.bots.find((bot) => bot.role === 'automation');
  const reviewer = data.bots.find((bot) => bot.role === 'review_lead');

  // Triage exists only on an organization's access page, so it is offered only
  // where the owner is known to be one; an owner nobody could look up — a
  // scratch install's, with no GitHub — gets write, which every page offers.
  const readOnly = data.organizationIsOrg === true ? 'triage' : 'write';
  check(`gives intake ${readOnly}, a role the repository's access page offers`, intake?.repositoryRole === readOnly, intake?.repositoryRole);
  check(
    `gives the automation account ${readOnly}, a role the repository's access page offers`,
    automation?.repositoryRole === readOnly,
    automation?.repositoryRole,
  );
  check(
    'gives the lead reviewer write, because an approval needs it',
    reviewer?.repositoryRole === 'write',
    reviewer?.repositoryRole,
  );
  check(
    'says why each account needs its access',
    data.bots.every((bot) => bot.accessReason.length > 10),
  );

  // ------------------------------------------------------------- the emails
  check(
    'suggests one address per bot, tagged on the operator’s mailbox',
    data.bots.every((bot) => bot.suggestedEmail?.endsWith('@example.test') && bot.suggestedEmail.includes('+fleetadlc-')),
    data.bots[0]?.suggestedEmail,
  );
  check(
    'suggests a different address for every bot',
    new Set(data.bots.map((bot) => bot.suggestedEmail)).size === data.bots.length,
  );

  const withoutEmail = await view('');
  check(
    'asks for an address rather than inventing one',
    withoutEmail.bots.every((bot) => bot.suggestedEmail === null),
    withoutEmail.bots[0]?.emailNote,
  );

  // --------------------------------------------------------- what is checked
  // Without a connected account there is nothing to ask GitHub with. Reporting
  // unknown is the truth; inventing a yes or no is not. CI has no credentials,
  // so both shapes have to pass: asked (every answer a boolean) or unknown
  // (every answer null). A mix would mean the page guessed for some bots.
  // Each bot is asked on its own, unauthenticated, so an answer can be missing
  // for some bots and present for others: GitHub's anonymous rate limit, shared
  // by every job on a CI runner's address, can cut in part-way through the
  // crew. A bot GitHub did not answer for is reported as unknown (null), which
  // is right; what must never happen is a guess.
  const existsAnswers = data.bots.map((bot) => bot.accountExists);
  const answered = existsAnswers.filter((value) => typeof value === 'boolean').length;
  const unknown = existsAnswers.filter((value) => value === null).length;
  check(
    'checks against GitHub whether each account exists',
    answered + unknown === existsAnswers.length,
    `${answered} answered by GitHub, ${unknown} unknown`,
  );
  check(
    'says whether the owner is an organization or a personal account',
    data.organizationIsOrg === null || typeof data.organizationIsOrg === 'boolean',
    `organizationIsOrg: ${data.organizationIsOrg}`,
  );
  check(
    'points the app link at the right settings page',
    data.organizationIsOrg === true
      ? data.links.newApp.includes('/organizations/')
      : data.links.newApp === 'https://github.com/settings/apps/new',
    data.links.newApp,
  );

  // ------------------------------------------------------- the app it needs
  check(
    'requires device flow and expiring tokens',
    data.appSettings.some((setting) => /Device Flow/i.test(setting.setting) && setting.value === 'checked') &&
      data.appSettings.some((setting) => /Expire user/i.test(setting.setting) && setting.value === 'checked'),
  );
  check(
    'tells the operator not to create a client secret',
    data.appSettings.some((setting) => /secret/i.test(setting.setting) && /do not/i.test(setting.value)),
  );
  check(
    'asks for the permissions the platform actually uses',
    ['Contents', 'Issues', 'Pull requests', 'Commit statuses', 'Metadata'].every((permission) =>
      data.appPermissions.some((entry) => entry.permission === permission),
    ),
    `${data.appPermissions.length} permissions`,
  );
  check(
    'subscribes the webhook to the events the bridge acts on',
    data.webhookEvents.length === 6 &&
      data.webhookEvents.includes('pull_request_review') &&
      // What labels a change deployed and finishes a promoted one.
      data.webhookEvents.includes('deployment_status'),
    data.webhookEvents.join(', '),
  );
  check('gives the exact webhook url', data.webhookUrl.endsWith('/webhooks/github'), data.webhookUrl);

  // -------------------------------------------------- reflecting real state
  const workingAccounts = (data.githubAccounts ?? []).filter((account) => account.signIn === 'signed-in').length;
  const accountsStep = data.steps.find((step) => step.step === 'github-accounts');
  // Fewer than two working sign-ins says why two accounts exist. Two or more
  // says how many are connected. The old seat counter (`N of`) counted bots.
  const accountsDetail =
    workingAccounts >= 2
      ? `${workingAccounts} accounts connected`
      : 'two accounts: one that does the work and one that approves it';
  check(
    'the GitHub accounts step says how many sign-ins work, or that two are needed',
    accountsStep?.detail === accountsDetail,
    accountsStep?.detail,
  );

  // A bot with a credential is reported as connected. This used to take a
  // bot the page already called connected and pass, which checked nothing:
  // now one that is not gets an authorization on record, the page is read
  // again, and the record is taken away.
  const unconnected = data.bots.find((bot) => !bot.connected && bot.role !== 'automation');
  const subject = unconnected ? await bots.getBotByName(unconnected.bot) : null;
  if (subject && !(await credentials.getCredential(subject.id))) {
    await credentials.recordAuthorization({
      botId: subject.id,
      githubLogin: `${subject.name}-onboarding-check`,
      githubUserId: null,
      secretRef: `onboarding-check-${subject.id}`,
      scopes: [],
      tokenExpiresAt: null,
      refreshExpiresAt: null,
    });
    try {
      const after = await view();
      const reported = after.bots.find((bot) => bot.slot === unconnected.slot);
      check('reports a bot with a stored credential as connected', reported?.connected === true, `${subject.name}: ${reported?.connected}`);
    } finally {
      await credentials.forgetAuthorization(subject.id);
    }
  }

  // ------------------------------------------------- the device flow surface
  // Started under the intake seat, as the console starts one: the seat stays
  // right after the bot takes its account's handle.
  const started = await fetch(`${BRIDGE}/v1/onboarding/bots/intake/connect`, {
    method: 'POST',
    headers: { 'x-fleetadlc-identity': 'onboarding test', ...AS_CONSOLE },
  });
  const body = await started.json();

  if (data.clientIdConfigured) {
    check('starts the device flow and returns a user code', started.ok && Boolean(body.userCode), body.userCode);
    check(
      'sends the person to github.com/login/device',
      String(body.verificationUri ?? '').includes('github.com/login/device'),
      body.verificationUri,
    );
  } else {
    check(
      'refuses to start the device flow without a client id, and says so',
      !started.ok && /client id/i.test(body.error ?? ''),
      body.error,
    );
  }

  const state = await fetch(`${BRIDGE}/v1/onboarding/bots/intake/connect`, { headers: AS_CONSOLE }).then((response) => response.json());
  check('reports the state of an authorization', typeof state.state === 'string', `state: ${state.state}`);
  check(
    'never hands a token to the browser',
    !JSON.stringify(state).match(/ghu_|ghr_|refreshToken/),
    'no token material in the response',
  );

  // ------------------------------------------------------ who the API serves
  const unsigned = await fetch(`${BRIDGE}/v1/onboarding`, { headers: { 'x-fleetadlc-identity': 'onboarding test' } });
  check('the bridge refuses /v1 to a caller without the console secret', unsigned.status === 401, `${unsigned.status}`);
  const signedOut = await fetch(`${CONSOLE}/onboarding`, { redirect: 'manual' });
  check('the console refuses a browser that has not signed in', signedOut.status === 401, `${signedOut.status}`);
  const signedIn = await signIn();
  check('the sign-in link sets a session', signedIn.status === 303 && signedIn.cookie.startsWith('fleetadlc_session='), `${signedIn.status}`);
  const session = { cookie: signedIn.cookie };

  // --------------------------------------------------------- the console page
  const page = await fetch(`${CONSOLE}/onboarding?email=owner@example.test`, { headers: session }).then((response) => response.text());
  // These assert on what the walkthrough always renders rather than on the copy
  // of whichever step happens to be current. Which step that is depends on how
  // far the install has got — CI has no app configured and so opens on a
  // different one from a laptop mid-setup — and the previous assertions were
  // pinned to sentences from two steps that the rewrite moved.
  check('the console renders the walkthrough on the server', page.includes('Set up OpenADLC'));
  // Suggested from the seat, since a connected bot's name is already a handle.
  check(
    'the page carries the copyable values',
    page.includes('fleetadlc-builder') && page.includes('owner+fleetadlc-builder@example.test'),
  );
  // Narrower than the assertion it replaces, which looked for one sentence about
  // work only a person can do — copy that belonged to a step this no longer
  // reliably lands on. This says only that the walkthrough's own steps reached
  // the page, which is what "rendered on the server" is worth checking for.
  //
  // It matches the hydration payload as well as visible markup, and that is the
  // honest reading of it: the server sent the step model, every step's title
  // in it, not that a particular step is on screen. Which step is on screen depends on how far the install
  // has got, and CI is not far.
  check(
    'the page carries the walkthrough steps',
    STEP_TITLES.every((title) => page.includes(title)),
    STEP_TITLES.filter((title) => !page.includes(title)).join(', ') || `all ${STEP_TITLES.length}`,
  );

  const proxied = await fetch(`${CONSOLE}/api/onboarding?email=owner@example.test`, { headers: session }).then((response) => response.json());
  check('the console proxies the onboarding api', proxied.bots?.length === crew.length);

  await query(`delete from audit where actor = 'onboarding test'`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} onboarding checks passed`);
  if (failed.length > 0) {
    console.log('\nfailed:');
    for (const failure of failed) console.log(`  ${failure.name}`);
  }
  console.log();

  await closePool();
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(`\nonboarding checks failed: ${error instanceof Error ? error.message : error}\n`);
  await closePool();
  process.exit(1);
});
