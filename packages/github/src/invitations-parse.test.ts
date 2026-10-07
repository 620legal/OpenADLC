import { describe, expect, it } from 'vitest';
import { pendingInvitationsFrom } from './invitations.js';

/**
 * The admin half of accepting an invitation.
 *
 * Only somebody with admin on the repository can see one, and only the invitee
 * can accept it. This reads the first so OpenADLC can do the second, and it parses
 * whatever `gh api` printed — including when a person pasted it.
 */
const LIST = JSON.stringify([
  {
    id: 1000001,
    invitee: { login: 'fleetadlc-atlas' },
    repository: { full_name: 'janedoe/FleetADLC' },
    expired: false,
  },
  {
    id: 1000002,
    invitee: { login: 'fleetadlc-cipher' },
    repository: { full_name: 'janedoe/FleetADLC' },
    expired: false,
  },
]);

describe('reading the invitations an admin can see', () => {
  it('pairs each id with the account it was sent to', async () => {
    // The pairing is the whole point: the id is useless without knowing which
    // bot has to present it.
    expect(pendingInvitationsFrom(LIST)).toEqual([
      { id: 1000001, invitee: 'fleetadlc-atlas', repository: 'janedoe/FleetADLC', expired: false },
      { id: 1000002, invitee: 'fleetadlc-cipher', repository: 'janedoe/FleetADLC', expired: false },
    ]);
  });

  it('accepts a single row, which is what pasting one invitation looks like', () => {
    const one = JSON.stringify({ id: 7, invitee: { login: 'fleetadlc-atlas' } });
    expect(pendingInvitationsFrom(one)).toHaveLength(1);
  });

  it('keeps an expired one, marked, rather than dropping it silently', () => {
    // An invitation that expired is why a bot is not in the repository. Hiding
    // it leaves somebody wondering; showing it says to send a new one.
    const expired = JSON.stringify([{ id: 9, invitee: { login: 'fleetadlc-vega' }, expired: true }]);
    expect(pendingInvitationsFrom(expired)[0]).toMatchObject({ invitee: 'fleetadlc-vega', expired: true });
  });

  it('skips a row it cannot read instead of failing the batch', () => {
    // Pasted input is not guaranteed well-formed, and one bad row should not
    // cost the other eight their acceptance.
    const mixed = JSON.stringify([{ id: 1, invitee: { login: 'fleetadlc-atlas' } }, { nonsense: true }, null]);
    expect(pendingInvitationsFrom(mixed).map((row) => row.invitee)).toEqual(['fleetadlc-atlas']);
  });

  it('reads several outputs pasted together, and gh’s --slurp pages, as one list', () => {
    // One `gh api` per repository, both pasted in the one box: `[…]\n[…]`.
    const other = JSON.stringify([{ id: 9, invitee: { login: 'fleetadlc-vega' }, repository: { full_name: 'janedoe/site' } }]);
    expect(pendingInvitationsFrom(`${LIST}\n${other}\n`).map((row) => row.id)).toEqual([1000001, 1000002, 9]);
    expect(pendingInvitationsFrom(JSON.stringify([JSON.parse(LIST), JSON.parse(other)])).map((row) => row.id)).toEqual([1000001, 1000002, 9]);
    // A login with a bracket in a string does not end the value early.
    expect(pendingInvitationsFrom('[{"id":1,"invitee":{"login":"a]b"}}] {"id":2,"invitee":{"login":"c"}}').map((row) => row.invitee)).toEqual(['a]b', 'c']);
  });

  it('is empty for something that is not JSON at all', () => {
    // Somebody pastes the command instead of its output. That is a nothing, not
    // a crash.
    expect(pendingInvitationsFrom('gh api repos/o/r/invitations')).toEqual([]);
    expect(pendingInvitationsFrom('')).toEqual([]);
  });
});
