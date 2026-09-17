/**
 * NVDA options wheel strategy — entry point, run once per weekday by
 * Task Scheduler at market open. Loops internally on a poll interval until
 * market close, then exits. See CLAUDE.md for the full design and the
 * verification steps (testOptionAuth/testOptionChain/testOptionOrderPreview)
 * that confirmed the API shapes used here against the live sandbox.
 *
 * Strategy recap:
 *   Stage PUT (no shares held): sell a cash-secured put ~10% below the
 *   current price, 2-4 weeks out. If it expires worthless, sell another.
 *   If assigned, move to stage CALL.
 *   Stage CALL (shares held): sell a covered call ~10% above cost basis,
 *   2-4 weeks out. If it expires worthless, sell another. If called away,
 *   move back to stage PUT.
 *   Either stage: close early at 50% of credit captured, checked every tick.
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import {
  getOptionChain,
  getOptionSnapshot,
  getAccountBalance,
  extractOptionBuyingPower,
  placeOptionOrder,
  pollOptionOrderFill,
  OptionContract,
} from "./optionsClient";
import { reconcile, addCumulativePremium, WheelState } from "./wheelState";
import { logTradeEvent } from "./tradeLogger";
import { isMarketHoliday, isAtOrAfterMarketClose, waitForMarketOpen, todayNyDate } from "./marketHours";

const SYMBOL = process.env.WHEEL_SYMBOL ?? "NVDA";
const CONTRACTS = parseInt(process.env.WHEEL_CONTRACTS ?? "5", 10);
const PUT_OTM_PCT = parseFloat(process.env.WHEEL_PUT_OTM_PCT ?? "0.10");
const CALL_ITM_PCT = parseFloat(process.env.WHEEL_CALL_ITM_PCT ?? "0.10");
const DTE_MIN = parseInt(process.env.WHEEL_DTE_MIN ?? "14", 10);
const DTE_MAX = parseInt(process.env.WHEEL_DTE_MAX ?? "28", 10);
const PROFIT_TAKE_PCT = parseFloat(process.env.WHEEL_PROFIT_TAKE_PCT ?? "0.50");
const POLL_INTERVAL_MS = parseInt(process.env.WHEEL_POLL_INTERVAL_MS ?? "900000", 10); // 15 min default

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDateDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr + "T00:00:00Z").getTime();
  return Math.round((target - Date.now()) / 86_400_000);
}

/** Picks the contract whose strike is closest to targetStrike, preferring
 * the contract AT-OR-ON-THE-CORRECT-SIDE of it (at/below for a put's OTM
 * target, at/above for a call's ITM-avoidance target) when one exists —
 * strikes only come in fixed increments, so an exact match is unlikely. */
function pickStrike(contracts: OptionContract[], targetStrike: number, preferAtOrBelow: boolean): OptionContract | null {
  if (contracts.length === 0) return null;
  const withStrike = contracts.map((c) => ({ c, strike: parseFloat(c.strike_price) }));
  const eligible = preferAtOrBelow
    ? withStrike.filter((x) => x.strike <= targetStrike)
    : withStrike.filter((x) => x.strike >= targetStrike);
  const pool = eligible.length > 0 ? eligible : withStrike; // fall back to the whole chain if nothing qualifies on the preferred side
  pool.sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));
  return pool[0].c;
}

/** Picks the expiration date closest to the midpoint of [DTE_MIN, DTE_MAX]
 * from the distinct expirations present in the chain. */
function pickExpiration(contracts: OptionContract[]): string | null {
  const dates = [...new Set(contracts.map((c) => c.expiration_date))];
  if (dates.length === 0) return null;
  const targetDte = (DTE_MIN + DTE_MAX) / 2;
  dates.sort((a, b) => Math.abs(daysUntil(a) - targetDte) - Math.abs(daysUntil(b) - targetDte));
  return dates[0];
}

async function fetchUnderlyingPrice(client: WebullClient, contracts: OptionContract[]): Promise<number | null> {
  // No dedicated stock-quote wrapper in this project (only options were
  // built out — see CLAUDE.md). Derive an approximate current price from
  // the option chain itself: for a near-the-money PUT, strike ~= price when
  // delta ~= -0.5. Simpler and good enough for picking a 10%-OTM strike:
  // take the ATM-ish middle of the available strikes as a proxy is fragile,
  // so instead pull a snapshot on the median strike and back into price
  // isn't reliable either. Use the sibling project's proven stock bars
  // endpoint instead, at v2 (already live-verified there).
  try {
    const bars = await client.get<Array<{ close: string }>>("/openapi/market-data/stock/bars", {
      symbol: SYMBOL,
      category: "US_STOCK",
      timespan: "M1",
      count: "1",
    });
    if (bars?.[0]?.close) return parseFloat(bars[0].close);
  } catch (err) {
    console.warn("[price] stock bars lookup failed, falling back to chain-implied estimate:", err);
  }
  return null;
}

interface SellResult {
  ok: boolean;
  contract?: OptionContract;
  creditPerContract?: number;
  clientOrderId?: string;
}

async function sellToOpen(
  client: WebullClient,
  accountId: string,
  optionType: "PUT" | "CALL",
  targetStrike: number,
  preferAtOrBelow: boolean
): Promise<SellResult> {
  const chain = await getOptionChain(client, {
    underlyingSymbol: SYMBOL,
    optionType,
    startDate: isoDateDaysFromNow(DTE_MIN),
    endDate: isoDateDaysFromNow(DTE_MAX),
  });
  if (chain.length === 0) {
    logTradeEvent({
      event: "guard_rejected",
      symbol: SYMBOL,
      stage: optionType === "PUT" ? "PUT" : "CALL",
      reason: "no_suitable_contract",
      detail: `Empty ${optionType} chain for ${SYMBOL} in the ${DTE_MIN}-${DTE_MAX} DTE window`,
    });
    return { ok: false };
  }

  const expiration = pickExpiration(chain);
  const sameExpiry = chain.filter((c) => c.expiration_date === expiration);
  const contract = pickStrike(sameExpiry, targetStrike, preferAtOrBelow);
  if (!expiration || !contract) {
    logTradeEvent({
      event: "guard_rejected",
      symbol: SYMBOL,
      stage: optionType === "PUT" ? "PUT" : "CALL",
      reason: "no_suitable_contract",
      detail: `Could not pick a strike/expiration near target ${targetStrike} from ${chain.length} contracts`,
    });
    return { ok: false };
  }

  const strike = parseFloat(contract.strike_price);
  const snap = await getOptionSnapshot(client, [contract.symbol]);
  const bid = snap[0]?.bid ? parseFloat(snap[0].bid) : null;
  if (bid === null || bid <= 0) {
    logTradeEvent({
      event: "guard_rejected",
      symbol: SYMBOL,
      stage: optionType === "PUT" ? "PUT" : "CALL",
      reason: "no_suitable_contract",
      detail: `No usable bid for ${contract.symbol}`,
    });
    return { ok: false };
  }

  try {
    const result = await placeOptionOrder(client, accountId, {
      underlyingSymbol: SYMBOL,
      optionSymbol: contract.symbol,
      side: "SELL",
      quantity: CONTRACTS,
      optionType,
      strikePrice: strike,
      expirationDate: expiration,
      limitPrice: bid, // sell at the bid — matches the convention noted in CLAUDE.md for a fill-likely limit
      positionIntent: "SELL_TO_OPEN",
    });
    const clientOrderId = (result.client_order_id as string) ?? "";

    // CONFIRMED LIVE (2026-09-09, first real fill): a limit sell at the bid
    // can fill BETTER than the bid (that day's fill was $1.11 vs. a $1.08
    // bid) — logging the requested limit price as "the credit" understates
    // the real number. Poll for the actual fill (same pattern as the
    // sibling project's pollOrderFill) and prefer that; fall back to the
    // requested price only if the poll times out, so the log still has a
    // number rather than nothing.
    const fill = await pollOptionOrderFill(client, accountId, clientOrderId);
    const creditPerContract = fill?.filledPrice ?? bid;
    if (!fill || fill.status !== "FILLED") {
      console.warn(
        `[order] fill for ${contract.symbol} not confirmed within poll window, logging requested limit price ${bid} instead of a confirmed fill`
      );
    }
    return { ok: true, contract, creditPerContract, clientOrderId };
  } catch (err) {
    console.error(`[order] SELL_TO_OPEN ${optionType} failed:`, err);
    logTradeEvent({
      event: "guard_rejected",
      symbol: SYMBOL,
      stage: optionType === "PUT" ? "PUT" : "CALL",
      reason: "preview_failed",
      detail: String(err),
    });
    return { ok: false };
  }
}

async function buyToClose(
  client: WebullClient,
  accountId: string,
  state: WheelState,
  optionType: "PUT" | "CALL"
): Promise<{ ok: boolean; debit?: number }> {
  const opt = state.openOption!;
  const snap = await getOptionSnapshot(client, [opt.optionSymbol]);
  const ask = snap[0]?.ask ? parseFloat(snap[0].ask) : null;
  if (ask === null) return { ok: false };

  try {
    const result = await placeOptionOrder(client, accountId, {
      underlyingSymbol: SYMBOL,
      optionSymbol: opt.optionSymbol,
      side: "BUY",
      quantity: opt.contracts,
      optionType,
      strikePrice: opt.strike,
      expirationDate: opt.expiration,
      limitPrice: ask,
      positionIntent: "BUY_TO_CLOSE",
    });
    // Same fix as the sell paths: prefer the confirmed fill over the
    // requested limit price for an accurate realized-P&L log.
    const clientOrderId = (result.client_order_id as string) ?? "";
    const fill = await pollOptionOrderFill(client, accountId, clientOrderId);
    const debit = fill?.filledPrice ?? ask;
    if (!fill || fill.status !== "FILLED") {
      console.warn(
        `[order] fill for ${opt.optionSymbol} BUY_TO_CLOSE not confirmed within poll window, logging requested limit price ${ask} instead of a confirmed fill`
      );
    }
    return { ok: true, debit };
  } catch (err) {
    console.error(`[order] BUY_TO_CLOSE ${optionType} failed:`, err);
    return { ok: false };
  }
}

export async function tick(client: WebullClient, accountId: string): Promise<void> {
  const state = await reconcile(client, accountId, SYMBOL);
  console.log(
    `[tick] stage=${state.stage} shares=${state.shares} costBasis=${state.costBasis ?? "n/a"} openOption=${
      state.openOption ? `${state.openOption.optionSymbol} x${state.openOption.contracts}` : "none"
    }`
  );

  // --- Open short option: check 50%-profit-take and expiry every tick,
  // regardless of stage (the same logic serves both put and call legs). ---
  if (state.openOption) {
    const opt = state.openOption;
    const expired = daysUntil(opt.expiration) < 0;

    if (opt.creditPerContract !== null) {
      const snap = await getOptionSnapshot(client, [opt.optionSymbol]);
      const currentPrice = snap[0]?.ask ? parseFloat(snap[0].ask) : null;
      const threshold = opt.creditPerContract * (1 - PROFIT_TAKE_PCT);
      // Explicit log every tick this runs — added 2026-09-11 after a daily
      // review flagged that "no closed_early event" was indistinguishable
      // from "the check silently failed to get a quote." Now every outcome
      // (triggered, held, or quote unavailable) leaves a line in the log.
      if (currentPrice === null) {
        console.log(`[profit-take] ${opt.optionSymbol}: no ask quote available this tick, skipping check`);
      } else {
        console.log(
          `[profit-take] ${opt.optionSymbol}: ask=$${currentPrice.toFixed(2)} vs threshold=$${threshold.toFixed(2)} (${(PROFIT_TAKE_PCT * 100).toFixed(0)}% of $${opt.creditPerContract.toFixed(2)} credit) -> ${
            currentPrice <= threshold ? "CLOSE" : "hold"
          }`
        );
      }
      if (currentPrice !== null && currentPrice <= threshold) {
        const result = await buyToClose(client, accountId, state, opt.optionType);
        if (result.ok) {
          const creditReceived = opt.creditPerContract * opt.contracts * 100;
          const debitPaid = (result.debit ?? 0) * opt.contracts * 100;
          const realizedPnl = creditReceived - debitPaid;
          addCumulativePremium(realizedPnl);
          logTradeEvent({
            event: opt.optionType === "PUT" ? "put_closed_early" : "call_closed_early",
            symbol: SYMBOL,
            optionSymbol: opt.optionSymbol,
            creditReceived,
            debitPaid,
            realizedPnl,
            pctOfCreditCaptured: creditReceived > 0 ? (creditReceived - debitPaid) / creditReceived : 0,
          });
          return; // re-reconcile next tick before deciding whether to sell another
        }
      }
    } else {
      console.log(`[profit-take] ${opt.optionSymbol}: no credit basis available this tick, skipping check`);
    }

    if (expired) {
      // Reconcile will reflect assignment (shares appearing) or expiry
      // (option position simply gone) on the NEXT tick, once the broker has
      // processed it — nothing to do here but log what we can infer now.
      // If shares are still absent from state.shares below, treat as
      // worthless-expiry for logging purposes; the next tick's reconcile()
      // is authoritative either way.
      if (opt.creditPerContract !== null) {
        const creditReceived = opt.creditPerContract * opt.contracts * 100;
        addCumulativePremium(creditReceived);
        logTradeEvent({
          event: opt.optionType === "PUT" ? "put_expired_worthless" : "call_expired_worthless",
          symbol: SYMBOL,
          optionSymbol: opt.optionSymbol,
          creditReceived,
        });
      }
      return;
    }

    // Still open, not yet at profit-take or expiry — nothing to do this tick.
    return;
  }

  // --- No open option: detect a just-completed assignment/call-away versus
  // simply "nothing sold yet," then sell the next leg. ---
  if (state.stage === "PUT") {
    if (state.shares > 0 && state.costBasis !== null) {
      // Shares appeared with no open put tracked — assignment happened
      // since the last tick. reconcile() already flips stage to CALL for
      // the object it returned, but this branch is keyed off stage==PUT
      // read from a STALE copy in theory only if reconcile didn't run —
      // it always runs above, so state.stage already reflects reality; this
      // branch is unreachable in practice and left only as a defensive log.
      logTradeEvent({
        event: "put_assigned",
        symbol: SYMBOL,
        optionSymbol: "unknown", // no longer available once the option position is gone
        strike: state.costBasis,
        contracts: CONTRACTS,
        shares: state.shares,
        costBasis: state.costBasis,
      });
    }

    const price = await fetchUnderlyingPrice(client, []);
    if (price === null) {
      logTradeEvent({
        event: "guard_rejected",
        symbol: SYMBOL,
        stage: "PUT",
        reason: "no_suitable_contract",
        detail: "Could not determine current NVDA price",
      });
      return;
    }

    const targetStrike = price * (1 - PUT_OTM_PCT);
    console.log(
      `[decision] NVDA price=$${price.toFixed(2)}, ${(PUT_OTM_PCT * 100).toFixed(0)}%-OTM target strike=$${targetStrike.toFixed(2)} (will pick the closest available strike at or below this)`
    );
    const requiredCash = targetStrike * 100 * CONTRACTS; // approximate — refined against the actual picked strike below is unnecessary since strikes near target move cash needs only marginally
    const balance = await getAccountBalance(client, accountId);
    const buyingPower = extractOptionBuyingPower(balance);
    if (buyingPower < requiredCash) {
      console.log(`[guard] insufficient cash: need ~$${requiredCash.toFixed(0)}, have $${buyingPower.toFixed(0)}`);
      logTradeEvent({
        event: "guard_rejected",
        symbol: SYMBOL,
        stage: "PUT",
        reason: "insufficient_cash",
        detail: `Need ~$${requiredCash.toFixed(0)} to cash-secure ${CONTRACTS} contract(s) at ~$${targetStrike.toFixed(2)} strike, have $${buyingPower.toFixed(0)}`,
      });
      return;
    }

    const sell = await sellToOpen(client, accountId, "PUT", targetStrike, true);
    if (sell.ok && sell.contract && sell.creditPerContract !== undefined) {
      const totalCredit = sell.creditPerContract * CONTRACTS * 100;
      logTradeEvent({
        event: "put_sold",
        symbol: SYMBOL,
        optionSymbol: sell.contract.symbol,
        strike: parseFloat(sell.contract.strike_price),
        expiration: sell.contract.expiration_date,
        contracts: CONTRACTS,
        creditPerContract: sell.creditPerContract,
        totalCredit,
        clientOrderId: sell.clientOrderId ?? "",
        underlyingPrice: price,
        targetStrike,
      });
    }
    return;
  }

  if (state.stage === "CALL") {
    if (state.shares === 0) {
      // Shares gone with no open call tracked — called away since the last
      // tick (same defensive-log caveat as the put branch above).
      return;
    }
    if (state.costBasis === null) {
      logTradeEvent({
        event: "guard_rejected",
        symbol: SYMBOL,
        stage: "CALL",
        reason: "no_suitable_contract",
        detail: "Holding shares but broker reported no cost basis — refusing to guess a strike floor",
      });
      return;
    }

    const targetStrike = state.costBasis * (1 + CALL_ITM_PCT);
    console.log(
      `[decision] cost basis=$${state.costBasis.toFixed(2)}, ${(CALL_ITM_PCT * 100).toFixed(0)}%-above target strike=$${targetStrike.toFixed(2)} (will pick the closest available strike at or above this)`
    );
    const chain = await getOptionChain(client, {
      underlyingSymbol: SYMBOL,
      optionType: "CALL",
      startDate: isoDateDaysFromNow(DTE_MIN),
      endDate: isoDateDaysFromNow(DTE_MAX),
      strikePriceGte: state.costBasis, // hard guard baked into the query itself: never even consider a strike below cost basis
    });
    if (chain.length === 0) {
      logTradeEvent({
        event: "guard_rejected",
        symbol: SYMBOL,
        stage: "CALL",
        reason: "strike_below_cost_basis",
        detail: `No CALL contracts at/above cost basis $${state.costBasis.toFixed(2)} in the ${DTE_MIN}-${DTE_MAX} DTE window`,
      });
      return;
    }

    const expiration = pickExpiration(chain);
    const sameExpiry = chain.filter((c) => c.expiration_date === expiration);
    const contract = pickStrike(sameExpiry, targetStrike, false);
    if (!expiration || !contract) return;

    // Redundant defense-in-depth check against the guard already applied via
    // strikePriceGte above — never trust a single layer for a hard rule.
    if (parseFloat(contract.strike_price) < state.costBasis) {
      logTradeEvent({
        event: "guard_rejected",
        symbol: SYMBOL,
        stage: "CALL",
        reason: "strike_below_cost_basis",
        detail: `Picked strike ${contract.strike_price} is below cost basis ${state.costBasis} — refusing`,
      });
      return;
    }

    const snap = await getOptionSnapshot(client, [contract.symbol]);
    const bid = snap[0]?.bid ? parseFloat(snap[0].bid) : null;
    if (bid === null || bid <= 0) return;

    try {
      const result = await placeOptionOrder(client, accountId, {
        underlyingSymbol: SYMBOL,
        optionSymbol: contract.symbol,
        side: "SELL",
        quantity: CONTRACTS,
        optionType: "CALL",
        strikePrice: parseFloat(contract.strike_price),
        expirationDate: expiration,
        limitPrice: bid,
        positionIntent: "SELL_TO_OPEN",
      });
      const clientOrderId = (result.client_order_id as string) ?? "";
      // Same fix as sellToOpen() for puts: prefer the confirmed fill price
      // over the requested limit price — a limit sell at the bid can fill
      // better than the bid, so logging the bid understates real credit.
      const fill = await pollOptionOrderFill(client, accountId, clientOrderId);
      const creditPerContract = fill?.filledPrice ?? bid;
      if (!fill || fill.status !== "FILLED") {
        console.warn(
          `[order] fill for ${contract.symbol} not confirmed within poll window, logging requested limit price ${bid} instead of a confirmed fill`
        );
      }
      const totalCredit = creditPerContract * CONTRACTS * 100;
      logTradeEvent({
        event: "call_sold",
        symbol: SYMBOL,
        optionSymbol: contract.symbol,
        strike: parseFloat(contract.strike_price),
        expiration,
        contracts: CONTRACTS,
        creditPerContract,
        totalCredit,
        costBasis: state.costBasis,
        clientOrderId,
        targetStrike,
      });
    } catch (err) {
      console.error("[order] SELL_TO_OPEN CALL failed:", err);
      logTradeEvent({
        event: "guard_rejected",
        symbol: SYMBOL,
        stage: "CALL",
        reason: "preview_failed",
        detail: String(err),
      });
    }
  }
}

async function main() {
  if (isMarketHoliday(new Date())) {
    console.log(`[startup] ${todayNyDate()} is a weekend/holiday — nothing to do, exiting`);
    process.exit(0);
  }

  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;
  if (!accountId) {
    throw new Error("WEBULL_SANDBOX_ACCOUNT_ID must be set in .env — refusing to guess an account.");
  }

  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const opened = await waitForMarketOpen();
  if (!opened) {
    console.log("[startup] market did not open today (or already closed) — exiting");
    process.exit(0);
  }

  console.log(
    `[startup] wheel agent starting: symbol=${SYMBOL} contracts=${CONTRACTS} putOtm=${PUT_OTM_PCT} callItm=${CALL_ITM_PCT} dte=${DTE_MIN}-${DTE_MAX} profitTake=${PROFIT_TAKE_PCT} pollMs=${POLL_INTERVAL_MS}`
  );

  while (!isAtOrAfterMarketClose(new Date())) {
    try {
      await tick(client, accountId);
    } catch (err) {
      console.error("[tick] unhandled error, will retry next tick:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.log("[shutdown] market closed, exiting for the day");
}

// Guarded so this module can be imported (e.g. by a one-shot manual
// verification script) without immediately starting the full wait-for-open
// + poll-until-close loop as a side effect of the import itself.
if (require.main === module) {
  main();
}
