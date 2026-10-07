import type { HealthCheck } from '../types.js';

/**
 * hostd starts every task and ends it. When it is down nothing new starts,
 * nothing running reports back, and each task a person is waiting on fails
 * with a transport error that names a port — so it is said once, here, as
 * what it is.
 */
export function hostCheck(hostd: { health(): Promise<{ ok: boolean }> }): HealthCheck {
  return {
    id: 'hostd',
    proves: 'OpenADLC’s host service answers, so a bot’s work can start and finish',
    how: 'asks hostd’s health route, which answers only while it is running',
    everyMinutes: 2,
    steps: [],
    async run() {
      const { ok } = await hostd.health();
      if (ok) return [{ ok: true, fixed: 'OpenADLC’s host service is answering again' }];
      return [
        {
          ok: false,
          severity: 'blocking',
          title: 'OpenADLC’s host service is not answering',
          detail:
            'hostd starts every bot’s work, so nothing new can start and nothing running can report back. ' +
            'Start OpenADLC again on the machine it runs on.',
          action: { label: 'Run fleetadlc up', command: 'fleetadlc up' },
        },
      ];
    },
  };
}

/** The card's title, which the docs repeat. */
export const LOCAL_DRIVER_TITLE = 'Tasks run on this machine as your user, not in containers';

/**
 * Under the local driver each task is a tmux session on the host, as the
 * user hostd runs as. A bot talked into it by what it reads — which
 * docs/security.md assumes can happen — can read the secret store and
 * install.json and run anything there. Nothing said so: `up` named the driver,
 * doctor warned only when Docker was missing, and the board was silent. A
 * warning, not blocking: development and the scratch suites run local on
 * purpose. hostd not answering is `hostCheck`'s card, not this one's.
 */
export function hostDriverCheck(hostd: { health(): Promise<{ ok: boolean; driver?: string }> }): HealthCheck {
  return {
    id: 'hostd-driver',
    proves: 'Each task runs in a container of its own, away from the install’s secrets',
    how: 'asks hostd’s health route which driver it runs tasks with',
    everyMinutes: 10,
    steps: [],
    async run() {
      const { ok, driver } = await hostd.health();
      // No answer is not a switch to docker: a card cleared then would come back.
      if (!ok) return [{ ok: null, reason: 'hostd is not answering, so its driver is not known' }];
      if (driver === 'docker') return [{ ok: true, fixed: 'Tasks run in containers of their own now' }];
      if (driver !== 'local') return [{ ok: true }];
      return [
        {
          ok: false,
          severity: 'warning',
          title: LOCAL_DRIVER_TITLE,
          detail:
            'hostd runs tasks with the local driver, so each bot’s session runs as your user on this machine. ' +
            'It can read the GitHub App’s private key, every bot’s sign-in, the model keys and the database password, ' +
            'and can run anything here. Use the local driver only with a throwaway App, accounts and repositories. ' +
            'To give each task its own container, build the bot image with `infra/local/build-bot-image.sh`, ' +
            'then run `fleetadlc init --driver docker` and `fleetadlc down && fleetadlc up`.',
          action: { label: 'Switch to the docker driver', command: 'infra/local/build-bot-image.sh && fleetadlc init --driver docker' },
        },
      ];
    },
  };
}
