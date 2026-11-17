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
import { getPositions, occSymbol, Position, PositionLeg } from "./optionsClient";

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

/** A BUY_TO_CLOSE order whose fill status couldn't be confirmed within the
 * poll window — CONFIRMED LIVE 2026-10-02: an order can take far longer to
 * settle than any reasonable poll window (that day, 13 minutes) and still
 * end up FILLED. Without this, the close was silently dropped from the log
 * and `cumulativePremium` permanently undercounted a real realized gain —
 * reconcile() already correctly picks up the position being gone on the
 * next tick (broker truth), but nothing else ever recomputed the P&L for
 * it. main.ts's resolvePendingClose() checks this order's real status each
 * tick until it resolves, then logs the correct event and clears this. */
export interface PendingClose {
  clientOrderId: string;
  optionSymbol: string;
  optionType: "PUT" | "CALL";
  contracts: number;
  creditPerContract: number;
  placedAt: string;
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

export function loadPendingClose(): PendingClose | null {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return raw.pendingClose ?? null;
  } catch {
    return null;
  }
}

export function setPendingClose(pending: PendingClose | null): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    // no snapshot yet — fine, start from empty
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ...raw, pendingClose: pending }, null, 2));
}

export interface ParsedPositions {
  shares: number;
  costBasis: number | null;
  openOption: OpenOption | null;
  /** Anything about the wheel symbol's positions this parser couldn't read
   * with confidence. Non-empty means reconcile() refuses to return a state
   * (see below) rather than guess. */
  problems: string[];
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function isOptionLeg(leg: PositionLeg): boolean {
  const t = String(leg.instrument_type ?? "").toUpperCase();
  if (t === "OPTION") return true;
  if (t === "EQUITY" || t === "STOCK") return false;
  return leg.option_type !== undefined || leg.option_exercise_price !== undefined || leg.option_expire_date !== undefined;
}

/**
 * Pure parser behind reconcile(), split out so it can be tested without the
 * broker (testReconcile.ts).
 *
 * Shapes handled:
 * - A single-leg option position (CONFIRMED LIVE 2026-09-09): top-level
 *   instrument_type OPTION, strike/expiry/type/cost under legs[0].
 * - A plain stock position: instrument_type EQUITY, no legs (or one stock leg).
 * - A COMBINED stock + covered-call position. FOUND 2026-11-16: once the
 *   wheel held 500 assigned shares and sold 5 calls, the broker stopped
 *   reporting a separate EQUITY position. The old code then saw shares=0,
 *   read the STOCK leg (legs[0]) as the option, built the snapshot symbol
 *   "NVDA", and every tick crashed on 417 INVALID_SYMBOL (51 failed runs on
 *   11-16/11-17). Each leg is now classified on its own, and a combined
 *   position's top-level cost_price (a blend of stock and option) is never
 *   used as either the stock cost basis or the option credit.
 *
 * The exact field layout of the combined position has NOT been seen
 * directly (the sandbox isn't reachable from where this was written), so
 * anything ambiguous goes into `problems` instead of being guessed.
 */
export function parseWheelPositions(positions: Position[], symbol: string): ParsedPositions {
  const problems: string[] = [];
  let shares = 0;
  let costBasis: number | null = null;
  const options: OpenOption[] = [];

  const mine = positions.filter(
    (p) => p.symbol === symbol || (p.legs ?? []).some((l) => l.symbol === symbol)
  );

  for (const p of mine) {
    const posQty = num(p.quantity);
    if (posQty === null || posQty === 0) continue;
    const legs = p.legs ?? [];
    const multiLeg = legs.length > 1;

    if (legs.length === 0) {
      const t = String(p.instrument_type ?? "").toUpperCase();
      if (t === "EQUITY" || t === "STOCK") {
        shares += posQty;
        costBasis = num(p.cost_price);
      } else {
        problems.push(`position with no legs and instrument_type ${p.instrument_type}`);
      }
      continue;
    }

    for (const leg of legs) {
      // Leg quantity: the leg's own field when present; a single-leg
      // position's leg shares the position's quantity; otherwise the
      // position (combo) quantity times the leg ratio (stock legs of a
      // covered-call combo usually carry ratio 100).
      let qty = num(leg.quantity);
      if (qty === null && !multiLeg) qty = posQty;
      if (qty === null && num(leg.ratio) !== null) qty = posQty * (num(leg.ratio) as number);

      if (isOptionLeg(leg)) {
        const optionType = leg.option_type;
        const expiration = leg.option_expire_date ?? "";
        const strike = num(leg.option_exercise_price);
        if ((optionType !== "PUT" && optionType !== "CALL") || !/^\d{4}-\d{2}-\d{2}$/.test(expiration) || strike === null) {
          problems.push(`option leg missing type/expiry/strike`);
          continue;
        }
        if (qty === null) qty = multiLeg ? posQty : null;
        if (qty === null) {
          problems.push(`option leg without a quantity`);
          continue;
        }
        // Credit per contract: the leg's own cost; a single-leg position may
        // also carry it at top level. Never a multi-leg combo's blended cost.
        const credit = num(leg.cost) ?? (multiLeg ? null : num(p.cost_price));
        options.push({
          optionSymbol: occSymbol(symbol, expiration, optionType, strike),
          strike,
          expiration,
          optionType,
          contracts: Math.abs(qty),
          creditPerContract: credit === null ? null : Math.abs(credit),
        });
      } else {
        if (!multiLeg && String(p.instrument_type ?? "").toUpperCase() === "OPTION") {
          problems.push(`OPTION position whose only leg has no option fields`);
          continue;
        }
        if (qty === null) {
          problems.push(`stock leg without a quantity (combo quantity ${p.quantity}, no leg quantity or ratio)`);
          continue;
        }
        shares += qty;
        const legCost = num(leg.cost) ?? num(leg.cost_price) ?? (multiLeg ? null : num(p.cost_price));
        if (legCost === null) problems.push(`stock leg without a cost basis`);
        else costBasis = legCost;
      }
    }
  }

  if (options.length > 1) problems.push(`${options.length} open option legs; the wheel expects at most one`);
  if (shares < 0) problems.push(`negative share count ${shares}`);

  return { shares, costBasis, openOption: options.length === 1 ? options[0] : null, problems };
}

/**
 * Rebuilds WheelState from live broker positions. Every numeric field from
 * Webull is a string; parseWheelPositions() handles the shapes.
 *
 * FAILS CLOSED: if the positions can't be read with confidence, this throws
 * with the raw positions in the message, so the run goes red, the
 * supervisor alerts, and the log shows the exact shape — instead of
 * returning a guess that could, for example, show "no option, no shares"
 * and make tick() sell five new puts on top of positions it can't see.
 */
export async function reconcile(client: WebullClient, accountId: string, symbol: string): Promise<WheelState> {
  const cumulativePremium = loadCumulativePremium();
  const positions = await getPositions(client, accountId);
  const parsed = parseWheelPositions(positions, symbol);
  if (parsed.problems.length > 0) {
    const raw = JSON.stringify(positions.filter((p) => p.symbol === symbol));
    throw new Error(`reconcile: can't read ${symbol} positions safely (${parsed.problems.join("; ")}). Raw: ${raw}`);
  }
  const { shares, costBasis, openOption } = parsed;

  const stage: Stage = shares > 0 ? "CALL" : "PUT";

  // pendingClose isn't part of WheelState (it's not broker-truth, it's local
  // bookkeeping for an order whose fill is still being confirmed) but this
  // write would otherwise silently drop it, since it overwrites the whole
  // file rather than merging — same pattern as cumulativePremium above.
  const pendingClose = loadPendingClose();
  const state: WheelState = { stage, openOption, shares, costBasis, cumulativePremium };
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ ...state, pendingClose, updatedAt: new Date().toISOString() }, null, 2)
  );
  return state;
}
