/**
 * Wheel-strategy state, reconciled from LIVE broker positions/open-orders on
 * every run — never trusted blindly from the on-disk snapshot. Same "broker
 * truth over local state" philosophy as the sibling project's
 * reconcile()/cooldown.ts (see that project's CLAUDE.md): a crash mid-day
 * can't leave this state permanently wrong, because it's rebuilt from
 * scratch each tick rather than mutated in place.
 *
 * wheel-state.json is written after each reconcile purely as a
 * human-readable snapshot (so a daily review or a manual check doesn't need
 * to hit the API) — it is NEVER read back to decide what to do next.
 */

import fs from "fs";
import path from "path";
import { WebullClient } from "./webullClient";
import { getPositions, occSymbol } from "./optionsClient";

export type Stage = "PUT" | "CALL";

export interface OpenOption {
  optionSymbol: string;
  strike: number;
  expiration: string;
  optionType: "PUT" | "CALL";
  contracts: number;
  /** Credit received per contract, read directly from the broker's own
   * position cost basis (CONFIRMED LIVE 2026-09-09: the positions endpoint
   * reports this reliably as `cost_price`/leg `cost`) — needed for the
   * 50%-profit-take check. An EARLIER version of this file self-remembered
   * this value in wheel-state.json because the option symbol needed to look
   * it up wasn't derivable; that turned out to be unnecessary AND broken
   * (the self-remembered key was built from a since-fixed wrong symbol
   * field) once it was clear the broker reports its own cost basis directly
   * on every position — always broker-truth now, never self-tracked. */
  creditPerContract: number | null;
}

export interface WheelState {
  stage: Stage;
  openOption: OpenOption | null;
  shares: number;
  costBasis: number | null;
  cumulativePremium: number;
}

const STATE_PATH = path.join(__dirname, "wheel-state.json");

function loadCumulativePremium(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return raw.cumulativePremium ?? 0;
  } catch {
    return 0;
  }
}

export function addCumulativePremium(delta: number): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    // no snapshot yet — fine, start from empty
  }
  const cumulativePremium = ((raw.cumulativePremium as number) ?? 0) + delta;
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ...raw, cumulativePremium }, null, 2));
}

/**
 * Rebuilds WheelState from live broker positions. Positions endpoint
 * returns both the underlying stock (instrument_type EQUITY) and any open
 * option contract (instrument_type OPTION) for the account.
 *
 * CONFIRMED LIVE (2026-09-09, first real fill): an option position's
 * strike/expiration/type/per-contract-cost live under `legs[0]`, not as
 * top-level fields, and the position carries NO option contract (OCC)
 * symbol anywhere — both the top-level `symbol` and the leg's own `symbol`
 * are just the underlying ticker. `occSymbol()` reconstructs the OCC symbol
 * from strike+expiration+type+underlying for snapshot-quote lookups. Every
 * numeric field from Webull is a string; parseFloat throughout.
 */
export async function reconcile(client: WebullClient, accountId: string, symbol: string): Promise<WheelState> {
  const cumulativePremium = loadCumulativePremium();
  const positions = await getPositions(client, accountId);

  const sharePosition = positions.find(
    (p) => p.instrument_type === "EQUITY" && p.symbol === symbol && parseFloat(p.quantity) > 0
  );
  const shares = sharePosition ? parseFloat(sharePosition.quantity) : 0;
  const costBasis = sharePosition && sharePosition.cost_price ? parseFloat(sharePosition.cost_price) : null;

  const optionPosition = positions.find(
    (p) => p.instrument_type === "OPTION" && p.symbol === symbol && Math.abs(parseFloat(p.quantity)) > 0
  );

  let openOption: OpenOption | null = null;
  if (optionPosition) {
    const leg = optionPosition.legs?.[0];
    const optionType = (leg?.option_type as "PUT" | "CALL" | undefined) ?? "PUT";
    const expiration = leg?.option_expire_date ?? "";
    const strike = leg?.option_exercise_price ? parseFloat(leg.option_exercise_price) : NaN;
    const creditRaw = optionPosition.cost_price ?? leg?.cost;

    openOption = {
      optionSymbol: expiration && !Number.isNaN(strike) ? occSymbol(symbol, expiration, optionType, strike) : symbol,
      strike,
      expiration,
      optionType,
      contracts: Math.abs(parseFloat(optionPosition.quantity)),
      creditPerContract: creditRaw ? parseFloat(creditRaw) : null,
    };
  }

  const stage: Stage = shares > 0 ? "CALL" : "PUT";

  const state: WheelState = { stage, openOption, shares, costBasis, cumulativePremium };
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  return state;
}
