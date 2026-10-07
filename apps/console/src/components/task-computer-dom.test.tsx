// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotSession } from '@/lib/api';

/**
 * A task's computer and terminal in a DOM: the keyboard goes to the session
 * on screen, a refusal is said, and a failed read of the sessions is not
 * shown as an idle bot.
 */

const actions = vi.hoisted(() => ({
  kill: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  restart: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
}));
vi.mock('@/app/actions', () => ({
  killSession: actions.kill,
  restartBot: actions.restart,
  restartTaskFresh: vi.fn(async () => ({ ok: true })),
  requestAttachToken: vi.fn(),
}));

/** Each terminal drawn, by session, and the ones let go: a socket lives as long as its terminal. */
const terminals = vi.hoisted(() => ({ mounted: [] as string[], closed: [] as string[] }));
vi.mock('@/components/terminal', () => ({
  Terminal: ({ session }: { session: string }) => {
    useEffect(() => {
      terminals.mounted.push(session);
      return () => void terminals.closed.push(session);
      // Mounted once per terminal: a new session on the same one is the bug.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <p data-terminal>{session}</p>;
  },
}));

const { ComputerTab, TerminalTab, Worktree, useSessions } = await import('./task-computer');

const LABEL = { said: 'the builder', name: 'builder', handle: null, text: 'builder' } as never;
const SESSIONS: BotSession[] = [
  { id: 's1', name: 'implement-aaaa', state: 'working', cmd: 'claude', pid: 76 },
  { id: 's2', name: 'shell-bbbb', state: 'idle', cmd: 'bash', pid: 77 },
] as never;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  terminals.mounted.length = 0;
  terminals.closed.length = 0;
  actions.kill.mockReset();
  actions.restart.mockReset();
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ pane: [], task: null })));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}`);
  return found;
}

async function settle(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe('the terminal tab', () => {
  it('lets go of one session’s terminal when another session is chosen', async () => {
    await act(async () => root.render(<TerminalTab bot="builder" label={LABEL} sessions={SESSIONS} />));
    expect(terminals.mounted).toEqual(['implement-aaaa']);

    await act(async () => button('shell-bbbb').click());
    // Kept, the socket to the first session took what was typed for the second.
    expect(terminals.closed).toEqual(['implement-aaaa']);
    expect(terminals.mounted).toEqual(['implement-aaaa', 'shell-bbbb']);
  });

  it('says why the sessions could not be read, rather than that there is nothing to attach to', async () => {
    await act(async () => root.render(<TerminalTab bot="builder" label={LABEL} sessions={[]} error="could not read builder’s sessions: hostd is down" />));
    expect(container.textContent).toContain('hostd is down');
    expect(container.textContent).not.toContain('Nothing to attach to');
  });
});

describe('the computer tab', () => {
  const draw = async (props: Record<string, unknown> = {}) => {
    const changed = vi.fn(async () => undefined);
    await act(async () => root.render(<ComputerTab bot="builder" label={LABEL} sessions={SESSIONS} onChanged={changed} {...props} />));
    return changed;
  };

  it('says the bridge’s refusal of a kill, and of stopping its work', async () => {
    await draw();
    actions.kill.mockResolvedValueOnce({ ok: false, error: 'hostd did not answer' });
    await act(async () => button('kill').click());
    await settle();
    expect(window.alert).toHaveBeenCalledWith('hostd did not answer');

    actions.restart.mockResolvedValueOnce({ ok: false, error: 'the seat is not running' });
    await act(async () => button('stop all its work').click());
    await settle();
    expect(window.alert).toHaveBeenCalledWith('the seat is not running');
  });

  it('gives the buttons back when the call itself fails', async () => {
    await draw();
    actions.kill.mockRejectedValueOnce(new Error('Failed to find Server Action'));
    await act(async () => button('kill').click());
    await settle();
    expect(button('kill').disabled).toBe(false);
    expect(button('stop all its work').disabled).toBe(false);
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('the console did not take that'));
  });

  it('says why the sessions could not be read, rather than that nothing is running', async () => {
    await draw({ sessions: [], error: 'could not read builder’s sessions: hostd is down' });
    expect(container.textContent).toContain('hostd is down');
    expect(container.textContent).not.toContain('nothing running in this container');
  });
});

describe('reading a bot’s sessions', () => {
  it('says the bridge’s refusal, and clears it once a read works', async () => {
    let answer: Response = Response.json({ error: 'hostd is down' }, { status: 502 });
    vi.stubGlobal('fetch', vi.fn(async () => answer));
    let seen: ReturnType<typeof useSessions> | null = null;
    function Probe() {
      seen = useSessions('builder');
      return null;
    }
    await act(async () => root.render(<Probe />));
    await settle();
    expect(seen!.error).toBe('could not read builder’s sessions: hostd is down');
    expect(seen!.sessions).toEqual([]);

    answer = Response.json({ stored: SESSIONS });
    await act(async () => seen!.reload());
    expect(seen!.error).toBeNull();
    expect(seen!.sessions).toHaveLength(2);
  });
});

describe('a bot’s worktree', () => {
  it('asks for it with the bot’s name encoded, so a name cannot reach another route', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url);
        return Response.json({ error: 'no task' }, { status: 404 });
      }),
    );
    await act(async () => root.render(<Worktree bot="x/../../repos" />));
    await settle();
    expect(asked[0]).toBe('/api/worktree/x%2F..%2F..%2Frepos?path=');
  });
});
