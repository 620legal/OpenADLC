import type { HealthCheck } from '../types.js';

export interface DispatchMode {
  /** Whether this bridge was started with the dispatcher (`FLEETADLC_DISPATCH_IN_BRIDGE=1`). */
  dispatching: boolean;
  /** Whether the engines are scripted (`FLEETADLC_SCRIPTED_ENGINES=1`), where the integration suites dispatch. */
  scripted: boolean;
  /**
   * Whether the bridge runs on Cloud Run (`K_SERVICE` is set there, as
   * `router.ts` reads it), where terraform sets its environment and a
   * `fleetadlc down && fleetadlc up` would restart some other, local install.
   */
  cloud: boolean;
}

/** How this bridge was started, read once from its environment so the check and the pause route agree. */
export function dispatchModeOf(dispatching: boolean, env: NodeJS.ProcessEnv = process.env): DispatchMode {
  return { dispatching, scripted: env.FLEETADLC_SCRIPTED_ENGINES === '1', cloud: Boolean(env.K_SERVICE) };
}

/** Whether anything leases an issue to a builder: this bridge's dispatcher, or the integration suites beside scripted engines. */
export function anythingDispatches(mode: DispatchMode): boolean {
  return mode.dispatching || mode.scripted;
}

/** The title the board's card carries, which the console's wording and the docs repeat. */
export const DISPATCHER_OFF_TITLE = 'The dispatcher isn’t running: nothing will start building';

/**
 * The bridge is the only thing that leases an issue to a builder, except
 * beside the integration suites, which drive the dispatcher a pass at a time
 * on an install whose engines are scripted (`bridgeDispatches` in the CLI's
 * `up.ts`). A bridge started without it looks healthy: intake, reviews and
 * deploys still start from GitHub's events, and only builds do not. One ran
 * like that for a day, with `FLEETADLC_DISPATCH_IN_BRIDGE=0` set by hand as a
 * pause, while Settings said "Work runs" and five issues sat in Build as
 * "Next up". So it is a blocking card until the bridge is restarted
 * with the dispatcher, which is when this passes.
 */
export function dispatcherCheck(mode: DispatchMode): HealthCheck {
  return {
    id: 'dispatcher',
    proves: 'The bridge runs the dispatcher, so an issue ready to build is leased to a builder',
    how: 'reads whether the bridge was started with FLEETADLC_DISPATCH_IN_BRIDGE=1, or with scripted engines, where the integration suites dispatch',
    everyMinutes: 5,
    steps: [],
    async run() {
      if (anythingDispatches(mode)) return [{ ok: true, fixed: 'The dispatcher is running again: issues ready to build are leased' }];
      return [
        {
          ok: false,
          severity: 'blocking',
          title: DISPATCHER_OFF_TITLE,
          detail:
            'The bridge was started without FLEETADLC_DISPATCH_IN_BRIDGE=1, so no issue is leased to a builder. Intake, reviews and ' +
            'deploys still start from GitHub’s events, which is why everything else looks fine. ' +
            (mode.cloud
              ? 'On Cloud Run the bridge’s environment is terraform’s: the cloud module sets FLEETADLC_DISPATCH_IN_BRIDGE=1 ' +
                '(infra/gcp/main.tf), so apply it again with `fleetadlc cloud apply`, which puts the setting back and restarts the bridge. '
              : 'Set FLEETADLC_DISPATCH_IN_BRIDGE=1 and restart the bridge: `fleetadlc down`, then `fleetadlc up`, which sets it. ') +
            'To stop new work for a while, use Settings → Pause work instead.',
          // The one thing to press has to act on the install that is off: on
          // Cloud Run a restart on the operator's machine would restart their
          // local install, if any, and leave the service as it was.
          action: mode.cloud
            ? { label: 'Apply the cloud install again', command: 'fleetadlc cloud apply' }
            : { label: 'Restart OpenADLC', command: 'fleetadlc down && fleetadlc up' },
        },
      ];
    },
  };
}
