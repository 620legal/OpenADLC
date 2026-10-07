'use client';

import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestAttachToken } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { socketFailure, terminalBase } from '@/lib/terminal-url';

type Phase = 'idle' | 'connecting' | 'attached' | 'detached' | 'error';

/**
 * The terminal's palette, from the tokens.
 *
 * `getComputedStyle` resolves the `oklch()` in the stylesheet to something the
 * canvas can use. If a token is missing — an old cached stylesheet, a test
 * environment with no CSS — the fallbacks are the values these were before they
 * moved, so the pane renders rather than coming up black on black.
 */
function terminalTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--color-term-bg', '#0b0d12'),
    foreground: token('--color-term-fg', '#e8eaee'),
    cursor: token('--color-term-cursor', '#7fd6b0'),
    selectionBackground: token('--color-term-selection', '#2a3040'),
  };
}

/**
 * Take-over in the panel. The socket carries a tmux client running inside the
 * bot's own computer, so detaching leaves the session — and the task — running.
 */
export function Terminal({
  bot,
  label = bot,
  session,
}: {
  /** The bot's name, which the attach token is asked for. */
  bot: string;
  /** What a person reads it as: its handle, or its role before an account is connected. */
  label?: string;
  session: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const term = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fit = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  const teardown = useCallback(() => {
    socket.current?.close();
    socket.current = null;
    term.current?.dispose();
    term.current = null;
    fit.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const attach = async (): Promise<void> => {
    // Whatever the last socket ended by — an error, the gateway closing, ctrl-b
    // d — its terminal goes first. Drawn over in place, it was never disposed,
    // and each retry left one more behind with its timers and handlers.
    teardown();
    setPhase('connecting');
    setError(null);

    // A server action that gets no answer rejects rather than returning an
    // error, and a rejection here left the tab saying "attaching" for good.
    const grant = await requestAttachToken(bot, session).catch(() => ({
      ok: false as const,
      token: undefined,
      url: undefined,
      error: 'the console is not answering, so it cannot ask for a terminal. Try again in a moment.',
    }));
    if (!grant.ok || !grant.token) {
      setError(grant.error ?? 'could not mint an attach token');
      setPhase('error');
      return;
    }

    const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);

    if (!host.current) return;
    const terminal = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      convertEol: true,
      // xterm paints to a canvas and cannot read a CSS custom property, so the
      // values are read off the document rather than written here twice. The
      // terminal stays dark in both modes deliberately — `globals.css` says why
      // — but reading them means that decision lives in one file.
      theme: terminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    host.current.innerHTML = '';
    terminal.open(host.current);
    fitAddon.fit();

    term.current = terminal;
    fit.current = fitAddon;

    // The gateway is its own surface, admitted to fewer people than the console:
    // the token is what ties this socket to one bot and one session.
    //
    // It is the subprotocol, not a query parameter. The request line is what a
    // proxy writes to its access log, and the token is a shell inside the bot.
    //
    // The address is the one the console runs with, which came with the token;
    // the one inlined at build time is only a fallback (lib/terminal-url.ts).
    const address = `${terminalBase(grant.url, process.env.NEXT_PUBLIC_FLEETADLC_TERMINAL_URL, window.location)}/terminal`;
    const ws = new WebSocket(address, [`fleetadlc-attach.${grant.token}`]);
    socket.current = ws;

    let opened = false;
    ws.onopen = () => {
      opened = true;
      setPhase('attached');
      // The first frame, before any keystroke: the gateway opens the pty at the
      // size it gives, so tmux paints the pane once, at this terminal's size.
      ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      terminal.focus();
    };
    ws.onmessage = (event) => terminal.write(String(event.data));
    ws.onerror = () => {
      setError(opened ? 'the terminal socket failed' : socketFailure(address, window.location.origin));
      setPhase('error');
    };
    ws.onclose = () => setPhase((current) => (current === 'error' ? current : 'detached'));

    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });
    terminal.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    const onWindowResize = (): void => fitAddon.fit();
    window.addEventListener('resize', onWindowResize);
    ws.addEventListener('close', () => window.removeEventListener('resize', onWindowResize));
  };

  const detach = (): void => {
    socket.current?.send(JSON.stringify({ type: 'detach' }));
    setTimeout(() => {
      teardown();
      setPhase('detached');
    }, 250);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {phase === 'attached' ? (
          <Chip tone="signal">you have the keyboard</Chip>
        ) : phase === 'connecting' ? (
          <Chip tone="attention">attaching</Chip>
        ) : phase === 'detached' ? (
          <Chip>detached; the session is still running</Chip>
        ) : phase === 'error' ? (
          <Chip tone="alarm">not attached</Chip>
        ) : (
          <Chip>not attached</Chip>
        )}
        <span className="text-[10.5px] text-dim">
          <span className="font-mono">{session}</span> · {label}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {phase === 'attached' ? (
            <Button size="sm" onClick={detach}>
              detach
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void attach()} disabled={phase === 'connecting'}>
              {phase === 'detached' || phase === 'error' ? 'attach again' : 'take over'}
            </Button>
          )}
        </div>
      </div>

      {error && <p className="rounded border border-alarm/40 bg-alarm/10 p-2 text-[11px] text-alarm">{error}</p>}

      <div
        ref={host}
        className="h-72 overflow-hidden rounded-md border border-edge bg-surface p-2"
        aria-label={`terminal for ${label}, session ${session}`}
      >
        {phase === 'idle' && (
          <p className="pane p-1 text-dim">
            Attaching runs tmux attach inside the container. Detaching leaves the session running, and every attach is
            audited with your identity.
          </p>
        )}
      </div>

      <p className="text-[10.5px] text-dim">
        ctrl-b d detaches from inside tmux; the Detach button does the same thing.
      </p>
    </div>
  );
}
