import { BridgeAnswered } from '@/lib/bridge-answered';

/**
 * What a page shows when it could not read the bridge: the console holds no
 * data of its own.
 *
 * No answer and an answer with an error are said apart. Both read "cannot
 * reach the bridge … start the stack with fleetadlc up", which sent a person
 * whose bridge was up, and had said why, to start it again — and on a cloud
 * install there is no `fleetadlc up` to run.
 */
export function BridgeDown({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'unknown error';
  if (error instanceof BridgeAnswered) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
        <h1 className="text-lg font-semibold">The bridge answered with an error</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          The bridge is running, but it answered {error.status} when the console asked it for this page, so there is nothing to
          show. What it said is below; its log says why. On the machine OpenADLC runs on,{' '}
          <span className="font-mono text-soft">fleetadlc logs bridge</span> says where that log is and{' '}
          <span className="font-mono text-soft">fleetadlc doctor</span> checks the rest; a cloud install keeps it in the bridge
          service’s logs. Then reload.
        </p>
        <pre className="pane mt-4 overflow-x-auto rounded-md border border-edge bg-panel p-3 text-muted">{message}</pre>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <h1 className="text-lg font-semibold">The console cannot reach the bridge</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        The console holds no data of its own, so there is nothing to show until the bridge answers. Start the stack with{' '}
        <span className="font-mono text-soft">fleetadlc up</span>, or check that the bridge is listening.
      </p>
      <pre className="pane mt-4 overflow-x-auto rounded-md border border-edge bg-panel p-3 text-muted">{message}</pre>
    </main>
  );
}
