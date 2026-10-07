import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/actions', () => ({
  killSession: vi.fn(),
  restartBot: vi.fn(),
  restartTaskFresh: vi.fn(),
  requestAttachToken: vi.fn(),
}));

const { ComputerTab, firstSession, sessionName } = await import('./task-computer');

const LABEL = { said: 'the builder', name: 'builder', handle: null, text: 'builder' } as never;
const SESSIONS = [{ id: 's1', name: 'implement-68e1726d', state: 'working', cmd: 'node', pid: 76 }] as never;

describe('which session a task is on', () => {
  it('is the session’s own name, never the bot/session record the task keeps', () => {
    // Handed on whole, the terminal asked for /v1/terminal/builder/builder/implement-…/token.
    expect(sessionName('builder/implement-68e1726d')).toBe('implement-68e1726d');
    expect(sessionName('implement-68e1726d')).toBe('implement-68e1726d');
    expect(firstSession([], 'builder/implement-68e1726d')).toBe('implement-68e1726d');
    expect(firstSession(SESSIONS, 'builder/implement-68e1726d')).toBe('implement-68e1726d');
  });
});

describe('what the computer tab offers', () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(<ComputerTab bot="builder" label={LABEL} sessions={SESSIONS} onChanged={async () => undefined} {...props} />);

  it('restarts the one task on a fresh computer, and does not say it restarts a container', () => {
    const html = render({ taskId: 'task-1', onAttach: () => undefined });
    expect(html).toContain('restart this task');
    expect(html).toContain('starts it again from its branch on a fresh computer');
    expect(html).not.toContain('restart container');
  });

  it('says on the seat that it stops all its work, which is what it does', () => {
    const html = render({});
    expect(html).toContain('stop all its work');
    expect(html).toContain('Stops every task');
  });

  it('opens a session in the terminal', () => {
    expect(render({ taskId: 'task-1', onAttach: () => undefined })).toContain('open terminal');
    expect(render({ taskId: 'task-1' })).not.toContain('open terminal');
  });
});
