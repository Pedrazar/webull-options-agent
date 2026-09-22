/**
 * Append-only wheel-strategy event log — one JSON object per line in
 * wheel-trades.jsonl. Same convention as ../webull-agent/tradeLogger.ts:
 * never rewritten or truncated, only appended to. This is the raw material
 * the daily review reads.
 */

import fs from "fs";
import path from "path";

const LOG_PATH = path.join(__dirname, "wheel-trades.jsonl");

export type WheelEvent =
  | {
      event: "put_sold";
      symbol: string;
      optionSymbol: string;
      strike: number;
      expiration: string;
      contracts: number;
      creditPerContract: number;
      totalCredit: number;
      clientOrderId: string;
      /** NVDA's price when this decision was made, and the exact 10%-OTM
       * target strike computed from it (price * (1 - PUT_OTM_PCT)) — the
       * actual `strike` above is the closest available strike AT OR BELOW
       * this target, since strikes only come in fixed increments. Recorded
       * so "why this strike" is answerable from the log alone. */
      underlyingPrice: number;
      targetStrike: number;
    }
  | {
      event: "put_closed_early";
      symbol: string;
      optionSymbol: string;
      creditReceived: number;
      debitPaid: number;
      realizedPnl: number;
      pctOfCreditCaptured: number;
    }
  | {
      event: "put_expired_worthless";
      symbol: string;
      optionSymbol: string;
      creditReceived: number;
    }
  | {
      event: "put_assigned";
      symbol: string;
      optionSymbol: string;
      strike: number;
      contracts: number;
      shares: number;
      costBasis: number;
    }
  | {
      event: "call_sold";
      symbol: string;
      optionSymbol: string;
      strike: number;
      expiration: string;
      contracts: number;
      creditPerContract: number;
      totalCredit: number;
      costBasis: number;
      clientOrderId: string;
      /** Exact 10%-above-cost-basis target strike (costBasis * (1 +
       * CALL_ITM_PCT)) — `strike` above is the closest available strike AT
       * OR ABOVE this target. Recorded for the same "why this strike"
       * traceability as put_sold's targetStrike. */
      targetStrike: number;
    }
  | {
      event: "call_closed_early";
      symbol: string;
      optionSymbol: string;
      creditReceived: number;
      debitPaid: number;
      realizedPnl: number;
      pctOfCreditCaptured: number;
    }
  | {
      event: "call_expired_worthless";
      symbol: string;
      optionSymbol: string;
      creditReceived: number;
    }
  | {
      event: "call_assigned";
      symbol: string;
      optionSymbol: string;
      strike: number;
      shares: number;
      costBasis: number;
      saleProceeds: number;
      capitalGain: number;
      totalPremiumThisCycle: number;
    }
  | {
      event: "guard_rejected";
      symbol: string;
      stage: "PUT" | "CALL";
      reason:
        | "insufficient_cash"
        | "strike_below_cost_basis"
        | "no_suitable_contract"
        | "preview_failed"
        // Added 2026-09-21 after a real live incident: an order was placed,
        // never filled (broker returned status CANCELLED, filled_quantity
        // 0), but the code logged put_sold anyway with a fabricated credit
        // number — see CLAUDE.md. Used when placeOptionOrder() succeeds but
        // the poll never confirms an actual FILLED status, for any of
        // sell-to-open (put or call) or buy-to-close.
        | "order_not_filled";
      detail: string;
    };

export function logTradeEvent(event: WheelEvent): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  fs.appendFileSync(LOG_PATH, line + "\n");
  console.log(`[trade-log] ${event.event} ${"symbol" in event ? event.symbol : ""}`.trim());
}
