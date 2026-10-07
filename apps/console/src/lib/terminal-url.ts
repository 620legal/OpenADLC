/**
 * Where take-over's socket goes: hostd's terminal gateway.
 *
 * `NEXT_PUBLIC_FLEETADLC_TERMINAL_URL` was read in browser code alone, so Next
 * fixed it when the console was built. A cloud console is built without it
 * (the service is started with it), so every one dialled port 47312 on its own
 * domain, where the load balancer does not listen, and take-over never
 * connected. The server action that mints the token now reads the value the
 * console runs with and hands it over with the token.
 */

/**
 * The gateway address the console runs with, out of `env`. A parameter, not
 * `process.env` read here: next.config.ts lists the variable under `env`, so
 * Next writes the build's value over `process.env.NEXT_PUBLIC_…` in server
 * code too, bracketed or not, and through a `const` alias of `process.env`
 * as well (each seen in the built chunk, where the value was gone).
 */
export function terminalUrlFrom(env: Record<string, string | undefined>): string | undefined {
  return env['NEXT_PUBLIC_FLEETADLC_TERMINAL_URL'] || undefined;
}

/** hostd's gateway port when nothing says otherwise. */
export const GATEWAY_PORT = 47312;

/**
 * The gateway's base address: the one the console runs with, then the one it
 * was built with — a console rebuilt with the variable, as the docs once said
 * to, keeps working — then port 47312 on the page's own host.
 */
export function terminalBase(
  runtimeUrl: string | null | undefined,
  builtUrl: string | null | undefined,
  location: { protocol: string; hostname: string },
): string {
  if (runtimeUrl) return runtimeUrl;
  if (builtUrl) return builtUrl;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${GATEWAY_PORT}`;
}

/**
 * What a socket that never opened says. A browser is not told why a
 * handshake failed, so this names the address it tried and the two settings
 * that decide it: where the gateway is, and which console hostd admits — a
 * console opened under another name (a LAN address, an SSH tunnel, a remapped
 * port) is refused. Blaming only the second sent a cloud console's operator
 * after a setting that was right.
 */
export function socketFailure(address: string, origin: string): string {
  return (
    `the terminal socket to ${address} failed. The address comes from NEXT_PUBLIC_FLEETADLC_TERMINAL_URL when the console is started with one, ` +
    `and is port ${GATEWAY_PORT} on this page's host otherwise. If that is where hostd's gateway is, hostd admits only the console ` +
    `FLEETADLC_CONSOLE_URL names; if that is not ${origin}, set it for hostd and restart it.`
  );
}
