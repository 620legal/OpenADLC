# 0091. The Costs page reads usage by range, and the header chip follows the budget state

- **Status:** accepted
- **Date:** 2026-11-26

## Context

The Costs page showed only the current month. It could not say which model
costs the most, or what the provider's cache saves (#368). The ledger now
records cache read and cache write as parts of `tokens_in` (ADR 0092).

The month's `GET /v1/costs` is read by the header on every page. The cap card,
CI minutes and "Stopped at the cap" belong to the month, because the cap is
monthly.

Subscription runs are priced as if billed, but they are not spend (ADR 0050).

The issue asked for the header chip to turn amber at 80%. The header already
follows the bridge's budget state, which warns at `warningAt` (0.9 by
default), the same threshold that sends `cap_warning` and colours the Costs
page's state chip. A fixed 80% would make the header disagree with them
between 80% and 90%. A person answered on #368: follow the bridge's warning.

## Decision

- **A range route.** `GET /v1/costs/usage?range=24h|7d|30d|90d|all` (a `user`
  route, 30 days when no range is named, a 400 that names the five otherwise)
  serves everything under the Costs page's picker: totals, the token split,
  cache savings, a series, by model, by engine, by bot, and the latest 50
  ledger rows in the range. The series has one bucket per hour for `24h` and
  per UTC day otherwise, each from the start of the range to now, with quiet
  buckets as zeros and rows held to the range's start, so the series adds up
  to the totals. `/v1/costs` is unchanged and stays the month's.
- **Billed and estimated are never summed.** Every figure carries
  `billedUsd` and `estimateUsd` apart, and no field adds one into the other.
  A breakdown's share is taken within its own kind: share of billed spend,
  and share of estimated spend. A kind whose total is 0 gives shares of 0.
- **Cache savings** are `cacheReadSavingsUsd(model, cacheRead)` in
  `pricing.ts`: cache-read tokens × (input rate − the cache-read rate
  `exactCost` charges) / 1e6, never below 0. They are summed per model at the
  install's current prices, and labelled an estimate wherever they appear.
  A model other than `claude-*` with no `cachedInPerMtok` is charged the full
  input rate on a cache read, so it saves $0. Uncached input is
  `tokens_in − cache_read − cache_write`, floored at 0, so a row from before
  the cache columns counts all of its input as uncached and saves $0.
- **The bridge prices with `config/models.yaml`.** `loadBridgeConfig` passes
  `readModelPrices`' table to `setModelPrice`, so `modelPrice` in the bridge
  answers as it does in a session.
- **The header chip follows the budget state.** It shows "$spent of $cap" for
  the month, links to Costs, and takes its colour from `spendLevel`: amber
  when the bridge says `warning` (at `warningAt`), red when `stopped`. It has
  no threshold of its own. With no cap (`capUsd <= 0`) it shows the spend
  alone, neutral and without a bar.

Nothing that feeds `monthSpend`, `refreshBudget`, the spending limits or the
leasing budget changes. Unbilled rows still count toward no cap.

## What this rules out

- **Widening `/v1/costs` with `?range=`.** The header reads it on every page,
  and the month's cap card would have to sit beside a range it does not
  follow.
- **Computing savings in SQL from a price table copied into the database.**
  That would be a second copy of the prices `config/models.yaml` already
  owns, and the two could drift.
- **A fixed 80% amber on the chip.** The header, the Costs page's state and
  `cap_warning` would disagree on a default install. An install that wants
  80% sets `warningAt: 0.8`, and everything follows it.
- **One "total" figure of billed plus estimated.** It would read as spend it
  is not (ADR 0050).

## What would make this worth revisiting

- Savings priced at today's rates misstate history once a vendor's price
  changes. If that error starts to matter, record the cache-read rate on each
  ledger row instead.
- If the cap stopped being monthly, "This month" above the picker would no
  longer be the cap's own period.
- If a person decides the chip should warn earlier than the bridge does, it
  needs its own threshold, and this decision changes.
