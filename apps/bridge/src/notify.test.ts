import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isNotifiable,
  itemLink,
  maskTarget,
  memoryNotifyStore,
  NOTIFIABLE,
  NOTIFY_SWITCHES,
  Notifier,
  ntfyOrigin,
  redactTarget,
  requestFor,
  forgetPersonalNotification,
  parsePersonNotify,
  personalNotificationView,
  savePersonalNotification,
  saveNotificationSettings,
  TEST_TEXT,
} from './notify.js';

/**
 * A few things are worth interrupting someone for and, just as deliberately,
 * nothing else. That second half is the part worth pinning: a
 * platform that notifies on everything is one whose notifications are ignored,
 * including the ones that mattered. A failing health check is sent once and
 * again a day later, and its all-clear to whoever was told; a pull request
 * waiting on a person and a review that stopped are read from Needs you.
 */
const configWith = (notifyWebhook: string) =>
  ({ notifyWebhook, consoleUrl: 'http://127.0.0.1:47300' }) as never;

const SLACK = 'https://hooks.slack.com/services/T000/B000/XyZsecretTOKENa1b2';
const TOPIC = 'openadlc-private-topic-a1b2';

const settingsTransport = (kind: 'ntfy' | 'slack' | 'webhook', target: string, setAt = '2026-11-02T00:00:00.000Z') =>
  memoryNotifyStore({
    settings: { notifyTransport: JSON.stringify({ kind, ...(kind === 'ntfy' ? { server: 'https://ntfy.sh' } : {}), setAt, setBy: 'janedoe' }) },
    target,
  });

function answering(status: number) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('only a few things are worth a notification', () => {
  it('is a gate, the spending warning, a waiting promote or merge, a stopped review, and a check a person has to act on', () => {
    expect([...NOTIFIABLE].sort()).toEqual([
      'cap_warning',
      'check_failing',
      'check_fixed',
      'gate_opened',
      'merge_waiting',
      'promote_waiting',
      'review_stalled',
    ]);
  });

  it('refuses anything else, rather than quietly sending it', () => {
    expect(isNotifiable('task_started')).toBe(false);
    expect(isNotifiable('pr_opened')).toBe(false);
    expect(isNotifiable('gate_answered')).toBe(false);
  });

  it('will not send an event it does not recognise even when asked directly', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const notifier = new Notifier(configWith('https://hooks.example.invalid/x'), memoryNotifyStore());

    const outcome = await notifier.send({
      event: 'gate_answered' as never,
      to: 'janedoe',
      text: 'answered',
      link: 'http://127.0.0.1:47300/',
    });

    expect(outcome).toBe('refused');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('an install with no transport carries on', () => {
  it('logs the intent rather than failing', async () => {
    const notifier = new Notifier(configWith(''), memoryNotifyStore());
    const outcome = await notifier.send({
      event: 'gate_opened',
      to: 'janedoe',
      text: 'waiting on an answer',
      link: 'http://127.0.0.1:47300/?bot=mira',
    });

    // Logged, not sent and not refused: the path stays exercised in development
    // rather than lying dormant until the day somebody configures it.
    expect(outcome).toBe('logged');
  });

  it('does not fail the caller when the transport is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const notifier = new Notifier(configWith('https://hooks.example.invalid/x'), memoryNotifyStore());

    // The gate is already on GitHub and on the board. A transport that is down
    // must not take the platform with it.
    await expect(notifier.send({ event: 'gate_opened', to: null, text: 'x', link: 'y' })).resolves.toBe('logged');
  });
});

describe('each transport is sent the request it reads', () => {
  const message = { event: 'gate_opened' as const, to: 'janedoe', text: 'Mira is waiting — ¿listo?', link: 'http://127.0.0.1:47300/?item=a%2312' };

  it('publishes to ntfy as JSON at the server’s root, which carries text that is not ASCII', () => {
    const { url, init } = requestFor({ kind: 'ntfy', target: TOPIC, server: 'https://ntfy.example.com/' }, message);
    expect(url).toBe('https://ntfy.example.com/');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      topic: TOPIC,
      title: 'OpenADLC',
      message: '@janedoe: Mira is waiting — ¿listo?',
      click: message.link,
      tags: ['gate_opened'],
    });
  });

  it('defaults ntfy to ntfy.sh', () => {
    expect(requestFor({ kind: 'ntfy', target: TOPIC }, message).url).toBe('https://ntfy.sh/');
  });

  it('posts Slack its text with the link as Slack writes one', () => {
    const { url, init } = requestFor({ kind: 'slack', target: SLACK }, { ...message, to: null });
    expect(url).toBe(SLACK);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ text: `Mira is waiting — ¿listo?\n<${message.link}|Open in OpenADLC>` });
  });

  it('escapes Slack’s formatting in the text, so the console’s is the only link', () => {
    const { init } = requestFor({ kind: 'slack', target: SLACK }, { ...message, to: null, text: 'See <https://evil.example|here> & <!channel>' });
    const { text } = JSON.parse(init.body as string) as { text: string };
    expect(text).toBe(`See &lt;https://evil.example|here&gt; &amp; &lt;!channel&gt;\n<${message.link}|Open in OpenADLC>`);
    expect(text.match(/</g)).toHaveLength(1);
  });

  it('posts the generic webhook the body it always had', () => {
    const { url, init } = requestFor({ kind: 'webhook', target: 'https://hooks.example.com/in' }, message);
    expect(url).toBe('https://hooks.example.com/in');
    expect(JSON.parse(init.body as string)).toEqual({ text: '@janedoe: Mira is waiting — ¿listo?', link: message.link, event: 'gate_opened' });
  });
});

describe('the target is a credential', () => {
  it('is shown as its host and last four characters, never more', () => {
    const pattern = /^(https?:\/\/[^/]+\/)?…[^/]{4}$/;
    expect(maskTarget('slack', SLACK)).toBe('https://hooks.slack.com/…a1b2');
    expect(maskTarget('webhook', 'https://hooks.example.com/in/secret-path-9z8y/')).toBe('https://hooks.example.com/…9z8y');
    expect(maskTarget('ntfy', TOPIC)).toBe('…a1b2');
    for (const masked of [maskTarget('slack', SLACK), maskTarget('ntfy', TOPIC)]) expect(masked).toMatch(pattern);
  });

  it('shows none of a short topic', () => {
    expect(maskTarget('ntfy', 'abcde')).toBe('…');
  });

  it('is taken out of an error, whole or by its path', () => {
    const error = `request to ${SLACK} failed; POST /services/T000/B000/XyZsecretTOKENa1b2 refused`;
    const redacted = redactTarget(error, SLACK);
    expect(redacted).not.toContain('XyZsecretTOKEN');
    expect(redacted).toBe('request to … failed; POST … refused');
    expect(redactTarget(`no topic ${TOPIC}`, TOPIC)).toBe('no topic …');
  });
});

describe('the ntfy server is an address and nothing more', () => {
  it('keeps only an origin', () => {
    expect(ntfyOrigin('https://ntfy.example.com/')).toBe('https://ntfy.example.com');
    expect(ntfyOrigin('http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080');
    for (const refused of ['https://user:pass@ntfy.example.com', 'https://token@ntfy.example.com', 'https://ntfy.sh/my-topic', 'https://ntfy.sh/?auth=x', 'https://ntfy.sh/#x', 'https://ntfy.sh?', 'ftp://ntfy.sh', 'ntfy.sh']) {
      expect(ntfyOrigin(refused), refused).toBeNull();
    }
  });

  it('refuses a server with a user, password or path, and keeps none of it', async () => {
    const store = memoryNotifyStore();
    for (const server of ['https://user:hunter2@ntfy.example.com', 'https://ntfy.sh/my-topic']) {
      const saved = await saveNotificationSettings(store, { kind: 'ntfy', server, target: TOPIC }, 'janedoe');
      expect(saved).toEqual({ ok: false, error: expect.stringContaining('no path, topic, user or password') });
    }
    expect(store.settings).toEqual({});
    expect(store.secret).toBeNull();
  });

  it('stores the server as its origin', async () => {
    const store = memoryNotifyStore();
    const saved = await saveNotificationSettings(store, { kind: 'ntfy', server: 'HTTPS://Ntfy.Example.com/', target: TOPIC }, 'janedoe');
    expect(saved).toMatchObject({ ok: true, change: { server: 'https://ntfy.example.com' } });
    expect(JSON.parse(store.settings.notifyTransport!)).toMatchObject({ server: 'https://ntfy.example.com' });
  });

  it('takes a user and password out of any URL in an error', () => {
    expect(redactTarget('connect to https://user:hunter2@ntfy.example.com/ failed', TOPIC)).toBe('connect to https://…@ntfy.example.com/ failed');
  });
});

describe('each delivery is recorded', () => {
  it('records an accepted send, without the target', async () => {
    answering(204);
    const store = settingsTransport('slack', SLACK);
    const notifier = new Notifier(configWith(''), store);

    await expect(notifier.send({ event: 'gate_opened', to: null, text: 'x', link: 'y' })).resolves.toBe('sent');

    const delivery = store.events.find((event) => event.type === 'notify.delivery');
    expect(delivery?.payload).toEqual({
      event: 'gate_opened',
      transport: 'slack',
      source: 'settings',
      setAt: '2026-11-02T00:00:00.000Z',
      ok: true,
      status: 204,
      error: null,
    });
    expect(JSON.stringify(store.events)).not.toContain('XyZsecret');
  });

  it('records a refused send with its status', async () => {
    answering(404);
    const store = settingsTransport('ntfy', TOPIC);
    const notifier = new Notifier(configWith(''), store);

    await expect(notifier.test()).resolves.toMatchObject({ ok: false, status: 404 });
    expect(store.events.filter((event) => event.type === 'notify.delivery')).toHaveLength(1);
  });

  it('records an unreachable endpoint with its error, the target taken out', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`getaddrinfo ENOTFOUND for ${SLACK}`));
    const store = settingsTransport('slack', SLACK);
    const notifier = new Notifier(configWith(''), store);

    const result = await notifier.test();
    expect(result).toMatchObject({ ok: false, status: null });
    expect(result?.error).toContain('ENOTFOUND');
    expect(result?.error).not.toContain('XyZsecret');
    expect(JSON.stringify(store.events)).not.toContain('XyZsecret');
  });

  it('sends Settings’ test with its own words and a link back to Settings', async () => {
    const fetchSpy = answering(200);
    const notifier = new Notifier(configWith(''), settingsTransport('ntfy', TOPIC));

    await expect(notifier.test()).resolves.toEqual({ ok: true, status: 200, error: null });
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ message: TEST_TEXT, click: 'http://127.0.0.1:47300/settings/notifications', tags: ['test'] });
  });

  it('has nothing to test with no transport', async () => {
    await expect(new Notifier(configWith(''), memoryNotifyStore()).test()).resolves.toBeNull();
  });
});

describe('each kind can be switched off', () => {
  it('lists a switch for each kind, a failing check and its all-clear as one', () => {
    expect([...NOTIFY_SWITCHES].sort()).toEqual(['cap_warning', 'check_failing', 'gate_opened', 'merge_waiting', 'promote_waiting', 'review_stalled']);
  });

  it('does not send a kind that is off, and records that it was', async () => {
    const fetchSpy = answering(200);
    const store = settingsTransport('slack', SLACK);
    store.settings.notifyKinds = JSON.stringify({ gate_opened: false });
    const notifier = new Notifier(configWith(''), store);

    await expect(notifier.send({ event: 'gate_opened', to: null, text: 'x', link: 'y' })).resolves.toBe('off');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.events).toEqual([expect.objectContaining({ type: 'notify.gate_opened', payload: expect.objectContaining({ off: true }) })]);
    expect(store.events.some((event) => event.type === 'notify.delivery')).toBe(false);
  });

  it('holds back a check’s all-clear with its failure', async () => {
    const fetchSpy = answering(200);
    const store = settingsTransport('slack', SLACK);
    store.settings.notifyKinds = JSON.stringify({ check_failing: false });
    const notifier = new Notifier(configWith(''), store);

    await expect(notifier.send({ event: 'check_fixed', to: null, text: 'x', link: 'y' })).resolves.toBe('off');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the kinds that are on', async () => {
    answering(200);
    const store = settingsTransport('slack', SLACK);
    store.settings.notifyKinds = JSON.stringify({ gate_opened: false });
    const notifier = new Notifier(configWith(''), store);

    await expect(notifier.send({ event: 'cap_warning', to: null, text: 'x', link: 'y' })).resolves.toBe('sent');
  });
});

describe('the environment’s webhook is the fallback', () => {
  it('posts today’s body to OPENADLC_NOTIFY_WEBHOOK when nothing is set in Settings', async () => {
    const fetchSpy = answering(200);
    const notifier = new Notifier(configWith('https://hooks.example.com/env'), memoryNotifyStore());

    await notifier.send({ event: 'gate_opened', to: null, text: 'x', link: 'y' });
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://hooks.example.com/env');
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual({ text: 'the owner: x', link: 'y', event: 'gate_opened' });
  });

  it('gives way to Settings’ choice', async () => {
    const fetchSpy = answering(200);
    const notifier = new Notifier(configWith('https://hooks.example.com/env'), settingsTransport('slack', SLACK));

    await notifier.send({ event: 'gate_opened', to: null, text: 'x', link: 'y' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(SLACK);
  });

  it('is used when Settings names a kind whose target a restore left behind', async () => {
    const store = settingsTransport('slack', SLACK);
    store.secret = null;
    const transport = await new Notifier(configWith('https://hooks.example.com/env'), store).transport();
    expect(transport).toMatchObject({ kind: 'webhook', source: 'env' });
  });
});

describe('a link about a piece of work opens its item', () => {
  it('names the subject, which any member of the item resolves from', () => {
    // A question about a request opened the intake bot's panel, with every
    // other request intake had worked on in it. Each request is its own conversation.
    expect(itemLink('http://127.0.0.1:47300/', 'openadlc#12')).toBe('http://127.0.0.1:47300/?item=openadlc%2312');
    expect(itemLink('http://127.0.0.1:47300', 'request:a4b02784')).toBe('http://127.0.0.1:47300/?item=request%3Aa4b02784');
  });
});

/**
 * A channel per person (ADR 0035): an item routed to some people goes to each
 * one's own channel and not to the install's, which reaches everyone on it.
 * Each person's target is a credential, kept apart and shown masked.
 */
describe('a person’s own channel', () => {
  const ALICE_TOPIC = 'alice-own-topic-9z8y';
  const withPeople = (people: Record<string, { kind: 'ntfy' | 'slack' | 'webhook'; target: string }>) =>
    memoryNotifyStore({
      settings: {
        notifyTransport: JSON.stringify({ kind: 'slack', setAt: '2026-11-02T00:00:00.000Z', setBy: 'janedoe' }),
        personNotify: JSON.stringify({
          people: Object.fromEntries(
            Object.entries(people).map(([id, one]) => [id, { kind: one.kind, ...(one.kind === 'ntfy' ? { server: 'https://ntfy.sh' } : {}), setAt: '2026-11-03T00:00:00.000Z' }]),
          ),
        }),
      },
      target: SLACK,
      personTargets: Object.fromEntries(Object.entries(people).map(([id, one]) => [id, one.target])),
    });

  it('sends a routed item to each of its people with a channel, once, and not to the install’s', async () => {
    const fetchSpy = answering(200);
    const store = withPeople({ 'p-a': { kind: 'ntfy', target: ALICE_TOPIC } });
    const notifier = new Notifier(configWith(''), store);

    await expect(notifier.send({ event: 'gate_opened', to: null, text: 'q', link: 'l', people: ['p-a', 'p-a', 'p-b'] })).resolves.toBe('sent');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ntfy.sh/');
    expect(JSON.parse(String(init.body))).toMatchObject({ topic: ALICE_TOPIC, message: 'q' });
    const delivery = store.events.find((event) => event.type === 'notify.delivery');
    expect(delivery?.payload).toMatchObject({ source: 'person', person: 'p-a', transport: 'ntfy', ok: true });
    expect(store.events.find((event) => event.type === 'notify.gate_opened')?.payload).toMatchObject({ people: ['p-a', 'p-a', 'p-b'] });
    expect(JSON.stringify(store.events)).not.toContain(ALICE_TOPIC);
  });

  it('sends nothing for a routed item whose people have no channel, and the install’s channel stays quiet', async () => {
    const fetchSpy = answering(200);
    const notifier = new Notifier(configWith(''), withPeople({}));
    await expect(notifier.send({ event: 'gate_opened', to: null, text: 'q', link: 'l', people: ['p-b'] })).resolves.toBe('logged');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends an item for everyone to the install’s channel, as it always did', async () => {
    const fetchSpy = answering(200);
    const notifier = new Notifier(configWith(''), withPeople({ 'p-a': { kind: 'ntfy', target: ALICE_TOPIC } }));
    await notifier.send({ event: 'gate_opened', to: null, text: 'q', link: 'l' });
    await notifier.send({ event: 'gate_opened', to: null, text: 'q', link: 'l', people: [] });
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([SLACK, SLACK]);
  });

  it('keeps a switched-off kind off for a person’s channel too', async () => {
    const fetchSpy = answering(200);
    const store = withPeople({ 'p-a': { kind: 'ntfy', target: ALICE_TOPIC } });
    store.settings.notifyKinds = JSON.stringify({ gate_opened: false });
    await expect(new Notifier(configWith(''), store).send({ event: 'gate_opened', to: null, text: 'q', link: 'l', people: ['p-a'] })).resolves.toBe('off');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never counts a person’s delivery as the install channel’s', async () => {
    answering(500);
    const store = withPeople({ 'p-a': { kind: 'ntfy', target: ALICE_TOPIC } });
    const notifier = new Notifier(configWith(''), store);
    await notifier.send({ event: 'gate_opened', to: null, text: 'q', link: 'l', people: ['p-a'] });
    const install = await notifier.transport();
    expect(install && (await notifier.lastDelivery(install))).toBeNull();
    expect((await personalNotificationView(notifier, 'p-a')).last).toMatchObject({ ok: false, status: 500 });
  });

  it('is saved with its kind in personNotify and its target only in the person’s secret, and shown masked', async () => {
    const store = memoryNotifyStore();
    const saved = await savePersonalNotification(store, 'p-a', { kind: 'ntfy', target: ALICE_TOPIC }, 'a@example.com', new Date('2026-11-10T00:00:00Z'));
    expect(saved).toEqual({ ok: true, change: { kind: 'ntfy', targetChanged: true } });
    expect(JSON.parse(store.settings.personNotify ?? '{}')).toEqual({ people: { 'p-a': { kind: 'ntfy', server: 'https://ntfy.sh', setAt: '2026-11-10T00:00:00.000Z' } } });
    expect(store.settings.personNotify).not.toContain(ALICE_TOPIC);
    expect(store.personSecrets['p-a']).toBe(ALICE_TOPIC);
    expect(store.secret).toBeNull();
    expect((await personalNotificationView(new Notifier(configWith(''), store), 'p-a')).target).toBe('…9z8y');

    // Another person's save keeps the first one's entry.
    await savePersonalNotification(store, 'p-b', { kind: 'slack', target: SLACK }, 'b@example.com');
    expect(Object.keys(parsePersonNotify(store.settings.personNotify ?? null).people).sort()).toEqual(['p-a', 'p-b']);
  });

  it('refuses a save the install’s channel would refuse, in the same words', async () => {
    const store = memoryNotifyStore();
    await expect(savePersonalNotification(store, 'p-a', { kind: 'slack', target: 'https://example.com/x' }, 'a')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('hooks.slack.com') });
    await expect(savePersonalNotification(store, 'p-a', { kind: 'ntfy' }, 'a')).resolves.toEqual({ ok: false, error: 'Enter the ntfy topic' });
    await expect(savePersonalNotification(store, 'p-a', { kind: 'ntfy', target: 't', server: 'https://u:p@ntfy.example.com' }, 'a')).resolves.toMatchObject({ ok: false });
    expect(store.settings.personNotify).toBeUndefined();
  });

  it('is stopped by the person, and forgotten when they are removed', async () => {
    const store = memoryNotifyStore();
    await savePersonalNotification(store, 'p-a', { kind: 'ntfy', target: ALICE_TOPIC }, 'a');
    await savePersonalNotification(store, 'p-b', { kind: 'ntfy', target: 'bob-topic' }, 'b');
    await expect(savePersonalNotification(store, 'p-a', { kind: null }, 'a')).resolves.toEqual({ ok: true, change: { kind: null, targetChanged: true } });
    expect(store.personSecrets['p-a']).toBeUndefined();
    await forgetPersonalNotification(store, 'p-b', 'admin@example.com');
    expect(store.personSecrets['p-b']).toBeUndefined();
    expect(store.settings.personNotify).toBeUndefined();
  });

  it('is read without entries for people who are gone, or of a kind it does not know', () => {
    const raw = JSON.stringify({ people: { 'p-a': { kind: 'ntfy', setAt: 'x' }, 'p-gone': { kind: 'slack', setAt: 'x' }, 'p-odd': { kind: 'pager', setAt: 'x' } } });
    expect(Object.keys(parsePersonNotify(raw, ['p-a', 'p-odd']).people)).toEqual(['p-a']);
    expect(parsePersonNotify('not json').people).toEqual({});
  });

  it('is tested through the person’s own channel, and says when there is none', async () => {
    const fetchSpy = answering(200);
    const notifier = new Notifier(configWith(''), withPeople({ 'p-a': { kind: 'ntfy', target: ALICE_TOPIC } }));
    await expect(notifier.testPerson('p-a')).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ topic: ALICE_TOPIC });
    await expect(notifier.testPerson('p-b')).resolves.toBeNull();
  });
});
