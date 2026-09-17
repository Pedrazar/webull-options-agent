# NVDA Options Wheel Agent

Sibling project to `../webull-agent` (a stock day-trading agent against the
same Webull OpenAPI sandbox account). This one runs an options wheel
strategy on NVDA: sell cash-secured puts ~10% below the current price
(2-4 weeks out); if assigned, hold the shares and sell covered calls ~10%
above cost basis (2-4 weeks out); if called away, go back to selling puts.
Any open short option is closed early once it can be bought back for ≤50%
of the credit received. Runs only during market hours, on this laptop via
local Windows Task Scheduler (not GitHub Actions — keeps sandbox
credentials off GitHub).

Build plan: see `C:\Users\pedra\.claude\plans\zany-spinning-brooks.md`.

## Status as of 2026-09-08 (initial build)

Full pipeline built: `webullClient.ts` (adapted from the sibling project,
per-request `x-version` instead of hardcoded), `optionsClient.ts` (option
chain/snapshot/balance/positions/order place-preview-cancel-replace),
`marketHours.ts` (lifted from the sibling project), `wheelState.ts`
(broker-truth reconcile, same philosophy as the sibling's `cooldown.ts`),
`tradeLogger.ts` (wheel-specific event union), `main.ts` (the poll-loop
state machine).

**Account correction (2026-09-08, same day as the initial build)**: the
account originally wired up (`RRGOR42Q9ITSC2LBJL6QRRFTH8`, "Individual
Margin") was the wrong one — the user wanted the **paper CASH account**,
"Individual Cash" (`account_id: 9DJ8VSNP9IG8C65ALGQS1V3PR9`, confirmed via
`/trading/accounts/list`). `.env`'s `WEBULL_SANDBOX_ACCOUNT_ID` now points
there. That account has `option_buying_power: $1,000,000` — the earlier
"can't afford even 1 contract" funding problem (Individual Margin only had
~$16,915) no longer applies; 5 contracts of NVDA puts is easily affordable
on Individual Cash.

Build order step 4 (a manual, hand-triggered live cycle) was run twice on
2026-09-08 against the Individual Cash account — the second attempt got
all the way through reconcile → cash guard → chain lookup → strike/
expiration selection → snapshot → a real `order/place` call, rejected only
by Webull's own after-hours gate (test ran 5:50pm ET, market closed). The
Task Scheduler jobs were then registered the same day. **See the
2026-09-09 status update below for what happened on the first real
scheduled run** — a real fill, and a same-day bugfix.

## Status update — 2026-09-09, evening (daily review findings + a 3rd bugfix)

The 1:20pm Pacific `WebullWheelDailyReview` ran and correctly flagged two
real issues:

1. **`wheel-state.json` still showed the broken shape** (`strike: null,
   expiration: "", creditPerContract: null`) even though the position-
   parsing fix (below) was already in the source by then. Expected, not a
   new bug: the 6:20am process had the OLD code loaded in memory and kept
   overwriting the snapshot every 15 minutes for the rest of the day — a
   source fix can't reach an already-running process (Session-0/S4U, can't
   be restarted from a non-elevated shell). Resolved on its own once that
   process exited at market close; will be correct from tomorrow's fresh
   6:25am launch onward.
2. **A genuinely NEW bug**, caught by the review noticing `wheel-trades.jsonl`'s
   `put_sold` credit ($1.08/contract = $540) didn't match this doc's
   ($1.11/contract = $555). The review assumed the trade log was
   "broker-confirmed" and this doc was wrong — actually the reverse:
   **$1.11 (this doc, read directly from the live position's `cost_price`)
   was the real fill; $1.08 was only the requested LIMIT price** (the
   quoted bid at order time). `sellToOpen()`/the inline call-sell path/
   `buyToClose()` never polled for the actual fill before logging — they
   just logged what was asked for, which can differ from what actually
   filled (a limit sell at the bid can fill better, as happened here).
   **Fixed**: all three now call `pollOptionOrderFill()` (already existed
   in `optionsClient.ts`, previously unused) and log the confirmed fill
   price, falling back to the requested price only if the poll times out.
   Not yet re-verified live (no order has been placed since this fix) —
   the next real sell or early-close is the verification.

**Also added (user asked "why did you choose that contract")**: `put_sold`
and `call_sold` trade-log events now carry `underlyingPrice`/`targetStrike`
(put) or `targetStrike` (call) — the exact price/target math behind the
pick, before rounding to the nearest available strike. Previously only the
final rounded `strike` was recorded, so the reasoning wasn't reconstructable
from the log alone; today's answer had to be inferred after the fact from
approximate price context. A matching `[decision]` console line was added
too. `run-wheel-daily-review.ps1`'s prompt updated to describe the new
fields. Not yet exercised live — no sell has happened since this was added.

## Status update — 2026-09-11 (profit-take observability)

2026-09-10's daily review (a genuinely quiet day, no trades, all three
2026-09-09 fixes confirmed holding) flagged a real gap: the per-tick log
only showed `stage/shares/openOption`, so "no `closed_early` event today"
was indistinguishable from "the profit-take check silently failed to get a
quote." Fixed: every tick with an open option now logs a `[profit-take]`
line — the ask vs. the 50% threshold and the CLOSE/hold outcome, or an
explicit "skipping check" reason (no quote, or no credit basis) if it
couldn't evaluate. `run-wheel-daily-review.ps1`'s prompt updated to read
and call out this line. Not yet exercised live at the moment this was
written (today's session was already running when the fix landed, so —
same Session-0/S4U restart limitation as the 2026-09-09 fixes — it applies
from tomorrow's fresh launch onward).

## Status update — 2026-09-09 (first real scheduled run)

`WebullWheelAgent` fired at 6:25am Pacific and sold the first real cycle at
market open: **5 contracts of `NVDA261002P00200000` (strike $200, exp
2026-10-02), filled at $1.11/contract = $555 total credit** — confirmed
against live positions, not just the trade log. Two operational issues
found and fixed the same morning:

1. **`WebullPreventLidSleep` silently failed to apply** (task history
   showed error `0x800710E0` — the same missed-wake/failed-catch-up
   signature documented in the sibling project). Machine was unprotected
   (`AC=1 Sleep, DC=2 Hibernate`) during the live trading window until
   manually re-triggered (`schtasks /Run /TN "WebullPreventLidSleep"`),
   which did correctly apply (`AC=0 DC=0`) once run. Root cause not fully
   diagnosed — worth watching whether this recurs; if it does, this
   directly risks the machine sleeping mid-session and killing the agent.
2. **`Position` parsing was wrong**, only discoverable once a real option
   position existed to inspect (see "API surface" below for the exact
   shape) — `wheelState.ts`'s `reconcile()` was reading `strike_price`/
   `expiration_date` fields that don't exist on a position (they're real,
   but only on the chain-list endpoint's contract objects, a different
   payload). The 50%-profit-take check and expiry detection were silently
   inert as a result (not crashing, just never firing) until fixed. **Fixed
   and confirmed live** the same morning — see below. The already-running
   6:20am process was NOT restarted with the fix (S4U/Session-0 processes
   can't be killed from a non-elevated shell — same constraint the sibling
   project hit); it self-heals at tomorrow's fresh 6:25am launch. Practical
   impact of leaving today's process on the old code: none expected — the
   position doesn't expire for 3+ weeks, and a same-day 50%+ price move on
   a 3-week put is unlikely, but not zero.

## API surface — CONFIRMED LIVE (2026-09-08) against the sandbox

None of this was previously used anywhere in the sibling project; every
endpoint below was verified via `testOptionAuth.ts` / `testOptionChain.ts` /
`testOptionOrderPreview.ts` before `main.ts` was trusted to use it.

- `GET /trading/accounts/list` (v3) — confirmed `WEBULL_SANDBOX_ACCOUNT_ID`
  (`RRGOR42Q9ITSC2LBJL6QRRFTH8`) is the "Individual Margin" account; the
  same sandbox login also has separate Cash/Futures/Events/Crypto accounts
  under the same `user_id` — never point this project at any of those.
- `GET /trading/assets/balances/get` (v3) — **response shape is NOT flat**:
  buying power is nested under `account_currency_assets[].option_buying_power`
  (per-currency array), not a top-level field. See
  `optionsClient.ts`'s `extractOptionBuyingPower()`.
- `GET /trading/instruments/options/contracts/list` (v3) — option chain.
  **The contract object's expiration field is `expiration_date`**, not
  `option_expire_date` as the Python SDK's request-builder naming might
  suggest — that latter name is real, but only inside an order-placement
  leg's body (a different payload entirely). Confusing them silently breaks
  chain filtering.
- `GET /market-data/options/snapshots/list` (v3) — quotes. **Real field
  names are `bid`/`ask`/`price`**, not `bid_price`/`ask_price` as the SDK
  docstring implied. Also returns full greeks (delta/gamma/theta/vega/rho),
  `open_interest`, `imp_vol` — unused today, but available if this strategy
  ever wants a delta-target strike picker instead of a flat percent-OTM one.
- `POST /openapi/trade/option/order/preview` and `.../order/place` (v3,
  **must** carry header `category: US_OPTION`) — **the single most
  important finding of this build**: a leg's `symbol` field must be the
  **underlying ticker** (`"NVDA"`), never the OCC option contract symbol
  (`"NVDA261002P00215000"`). Sending the OCC symbol fails every time with
  `OPENAPI_PARAM_ERR: "Parameter error, invalid market,symbol,option_type,
  strike_price,option_expire_date"` — the message names all four fields as
  invalid together even though only `symbol` is wrong, which is what made
  this non-obvious; it was root-caused by testing both variants side by
  side against the live preview endpoint. The API identifies a contract by
  underlying+strike+expiry+type, not by an OCC string. See
  `optionsClient.ts`'s `BuildOptionOrderParams` doc comment.
- Order fill polling and open-orders reuse the sibling project's
  **already-live-verified** `/openapi/trade/order/detail` and
  `/openapi/trade/order/open` (both `x-version: v2`, the client's default)
  rather than the newer-but-unverified v3 equivalents
  (`/trading/orders/...`) — these two are generic across instrument types.
- Options orders never support `MARKET` (LIMIT/STOP_LOSS/STOP_LOSS_LIMIT
  only) and sell-side orders only support `time_in_force: DAY` (GTC is
  buy-side only) — both per the SDK/skills docstrings, not yet indepedently
  exercised live (this project always sends LIMIT+DAY, so neither
  constraint has been hit).
- **`GET /trading/assets/positions/list` OPTION entry shape — CONFIRMED
  LIVE 2026-09-09** against a real filled position, and it does NOT match
  the chain-list endpoint's field names (a mistake the original guess made,
  see the 2026-09-09 status update above). Strike/expiration/type/per-leg
  cost live under `legs[0]`, not top-level: `option_exercise_price` (not
  `strike_price`), `option_expire_date` (not `expiration_date`), and
  `option_type`. **No OCC option symbol appears anywhere in the response**
  — both the position's own `symbol` and the leg's `symbol` are just the
  underlying ticker ("NVDA"). `optionsClient.ts`'s `occSymbol()` reconstructs
  it from strike+expiration+type+underlying when one is needed (e.g. for a
  snapshot-quote lookup). Per-contract cost basis is reliably available as
  `cost_price` (top-level) / `cost` (leg-level) — this is what the
  50%-profit-take check now reads directly every tick, rather than the
  earlier design's self-remembered `lastKnownCredit` (removed entirely once
  it was clear broker-truth was always available and the self-remembered
  approach was actually the thing silently broken).

## Design notes

- **State is broker-truth, not trusted from disk.** `wheelState.ts`'s
  `reconcile()` rebuilds `{stage, openOption, shares, costBasis}` from live
  positions on every tick; `wheel-state.json` is written purely as a
  human-readable snapshot and never read back to decide what to do next.
  Same philosophy as the sibling project's `cooldown.ts`/`reconcile()` — a
  crash mid-day can't leave this permanently wrong.
- **The 50%-profit-take credit reference (`creditPerContract`) is
  self-remembered, not broker-reported.** `wheelState.ts` persists it in
  `wheel-state.json`'s `lastKnownCredit` map, keyed by option symbol, right
  after a confirmed sell. If this process is ever restarted mid-cycle after
  that map is somehow lost, the profit-take check is skipped (not guessed)
  for that position until it naturally expires or gets assigned/called away.
- **Underlying price** comes from the sibling project's already-verified
  `/openapi/market-data/stock/bars` (v2, 1-minute bar close) — this project
  never built its own stock-quote wrapper since options were the only new
  ground to cover.
- **Two independent layers** enforce "never sell a call below cost basis":
  the option-chain query itself is bounded with `strike_price_gte:
  costBasis`, AND the picked contract is re-checked against `costBasis`
  before the order is placed. Both must agree; either alone was judged not
  trustworthy enough for a hard rule.

## Build order status

1. ✅ `testOptionAuth.ts` — account list + balance, live-confirmed.
2. ✅ `testOptionChain.ts` — NVDA PUT chain (166 contracts, 14-28 DTE) +
   snapshot, live-confirmed.
3. ✅ `testOptionOrderPreview.ts` — preview accepted after fixing the
   underlying-symbol-vs-OCC-symbol issue above.
4. ✅ **Done as of 2026-09-09** — the first real scheduled run placed and
   filled a real cash-secured put (see the 2026-09-09 status update above),
   and `reconcile()` was confirmed live to read the resulting position back
   correctly after the same-day fix.

## Scheduling (active)

**Registered and running as of 2026-09-08** (via `.task-xml\setup-wheel-tasks.ps1`,
run from an elevated PowerShell — task creation/enabling for S4U-principal
tasks requires admin rights, confirmed live): `WebullWheelAgent` (6:25am
Pacific weekdays → `run-wheel-agent.cmd` → `main.ts`, polls every
`WHEEL_POLL_INTERVAL_MS` until 4pm ET, then exits) and
`WebullWheelDailyReview` (1:20pm Pacific weekdays →
`run-wheel-daily-review.ps1`, same headless
`claude -p --allowedTools Read,Glob,Grep` pattern as the sibling project's
daily review). The laptop needs to be awake 6:20am-1:25pm Pacific weekdays
for this to run reliably — rather than creating a new pair of power-setting
tasks, the setup script re-enables the sibling project's existing
`WebullPreventLidSleep`/`WebullRestoreLidSleep` (5:45am-1:30pm Pacific),
whose window already fully covers this project's needs. **Known
reliability gap (2026-09-09)**: `WebullPreventLidSleep` failed to actually
apply on its first scheduled morning (error `0x800710E0`) — see the
2026-09-09 status update above. Worth checking each morning for now.

## Config (`.env`)

`WHEEL_SYMBOL` (NVDA), `WHEEL_CONTRACTS` (5), `WHEEL_PUT_OTM_PCT` (0.10),
`WHEEL_CALL_ITM_PCT` (0.10), `WHEEL_DTE_MIN`/`WHEEL_DTE_MAX` (14/28),
`WHEEL_PROFIT_TAKE_PCT` (0.50), `WHEEL_POLL_INTERVAL_MS` (900000 = 15 min).
