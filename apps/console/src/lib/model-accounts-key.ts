/**
 * What the AI models card is keyed on: which account each bot thinks with. Not
 * the accounts themselves: adding or removing one refreshes the page, and
 * drawing the card again then would take away the note its first check left.
 *
 * It lives outside the card because the settings page, a server component,
 * computes it; a server component can render a component exported from a
 * `'use client'` module but cannot call a plain function exported from one.
 */
export function modelAccountsKey(bots: readonly { name: string; modelAccountId?: string | null }[]): string {
  return bots.map((bot) => `${bot.name}:${bot.modelAccountId ?? ''}`).join(',');
}
