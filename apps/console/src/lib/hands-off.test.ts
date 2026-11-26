import { describe, expect, it } from 'vitest';
import { badgeOrder, badgeText, handsOffViewOf, timeLeft, type HandsOffWindowView } from './hands-off';

const NOW = Date.parse('2026-11-25T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const window = (repo: string, endsAt: string | null): HandsOffWindowView => ({
  repo,
  fullName: `acme/${repo}`,
  setByLogin: 'janedoe',
  setAt: at(-60),
  endsAt,
  duration: endsAt ? '8h' : 'until_off',
});

describe('the time a hands-off window has left', () => {
  it('is said in hours and minutes, minutes alone under an hour, or until turned off', () => {
    expect(timeLeft(at(479), NOW)).toBe('7h 59m');
    expect(timeLeft(at(12), NOW)).toBe('12m');
    expect(timeLeft(at(60), NOW)).toBe('1h 0m');
    expect(timeLeft(null, NOW)).toBe('until turned off');
  });

  it('says a minute while seconds are left, and nothing once it has passed', () => {
    expect(timeLeft(new Date(NOW + 20_000).toISOString(), NOW)).toBe('1m');
    expect(timeLeft(at(0), NOW)).toBeNull();
    expect(timeLeft(at(-5), NOW)).toBeNull();
    expect(timeLeft('not a time', NOW)).toBeNull();
  });
});

describe('the badge', () => {
  it('lists the soonest end first, until-off last, and drops one whose time has passed', () => {
    const windows = [window('until', null), window('later', at(300)), window('gone', at(-1)), window('soon', at(30))];
    expect(badgeOrder(windows, NOW).map((one) => one.repo)).toEqual(['soon', 'later', 'until']);
  });

  it('names the soonest window and how many more, and is nothing with none open', () => {
    expect(badgeText([window('api', at(372)), window('web', null)], NOW)).toEqual({ label: 'Hands-off · api · 6h 12m', more: 1 });
    expect(badgeText([window('api', at(-1))], NOW)).toBeNull();
    expect(badgeText([], NOW)).toBeNull();
  });
});

describe('a read of the windows', () => {
  it('is a view only when it lists windows, and nothing otherwise', () => {
    expect(handsOffViewOf({ windows: [], repos: ['api'], mayTurnOn: true })).toEqual({ windows: [], repos: ['api'], mayTurnOn: true });
    expect(handsOffViewOf({ error: 'the bridge is not answering' })).toBeNull();
    expect(handsOffViewOf({ items: [] })).toBeNull();
    expect(handsOffViewOf(null)).toBeNull();
  });
});
