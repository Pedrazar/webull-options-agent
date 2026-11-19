/**
 * Offline tests for parseWheelPositions() (no broker, no network):
 *   npx tsx testReconcile.ts
 * The covered-call combo fixtures are best guesses at the shape the broker
 * started returning on 2026-11-16 (see wheelState.ts); the single-put
 * fixture is the shape confirmed live on 2026-09-09.
 */
import assert from "assert";
import { parseWheelPositions } from "./wheelState";
import { Position } from "./optionsClient";

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${(e as Error).message}`);
  }
}

const spyCall: Position = {
  symbol: "SPY", instrument_type: "OPTION", quantity: "1", cost_price: "2.54",
  legs: [{ symbol: "SPY", option_type: "CALL", option_expire_date: "2026-11-17", option_exercise_price: "736", cost: "2.54" }],
};

test("single short put (confirmed live shape)", () => {
  const r = parseWheelPositions([
    { symbol: "NVDA", instrument_type: "OPTION", quantity: "-5", cost_price: "1.11",
      legs: [{ symbol: "NVDA", option_type: "PUT", option_expire_date: "2026-10-02", option_exercise_price: "200", cost: "1.11" }] },
    spyCall,
  ], "NVDA");
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.shares, 0);
  assert.strictEqual(r.openOption?.optionSymbol, "NVDA261002P00200000");
  assert.strictEqual(r.openOption?.contracts, 5);
  assert.strictEqual(r.openOption?.creditPerContract, 1.11);
});

test("separate stock and call positions", () => {
  const r = parseWheelPositions([
    { symbol: "NVDA", instrument_type: "EQUITY", quantity: "500", cost_price: "193.84" },
    { symbol: "NVDA", instrument_type: "OPTION", quantity: "-5", cost_price: "0.56",
      legs: [{ symbol: "NVDA", option_type: "CALL", option_expire_date: "2026-12-11", option_exercise_price: "215", cost: "0.56" }] },
  ], "NVDA");
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.shares, 500);
  assert.strictEqual(r.costBasis, 193.84);
  assert.strictEqual(r.openOption?.optionSymbol, "NVDA261211C00215000");
  assert.strictEqual(r.openOption?.creditPerContract, 0.56);
});

test("covered-call combo, legs carry their own quantities", () => {
  const r = parseWheelPositions([
    { symbol: "NVDA", instrument_type: "OPTION", quantity: "5", cost_price: "193.28",
      legs: [
        { symbol: "NVDA", instrument_type: "EQUITY", quantity: "500", cost: "193.84" },
        { symbol: "NVDA", instrument_type: "OPTION", quantity: "-5", option_type: "CALL", option_expire_date: "2026-12-11", option_exercise_price: "215", cost: "0.56" },
      ] },
    spyCall,
  ], "NVDA");
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.shares, 500);
  assert.strictEqual(r.costBasis, 193.84);
  assert.strictEqual(r.openOption?.optionSymbol, "NVDA261211C00215000");
  assert.strictEqual(r.openOption?.contracts, 5);
  assert.strictEqual(r.openOption?.creditPerContract, 0.56);
});

test("covered-call combo, legs carry ratios instead of quantities", () => {
  const r = parseWheelPositions([
    { symbol: "NVDA", instrument_type: "OPTION", quantity: "5", cost_price: "193.28",
      legs: [
        { symbol: "NVDA", ratio: "100", cost: "193.84" },
        { symbol: "NVDA", ratio: "1", option_type: "CALL", option_expire_date: "2026-12-11", option_exercise_price: "215", cost: "-0.56" },
      ] },
  ], "NVDA");
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.shares, 500);
  assert.strictEqual(r.openOption?.contracts, 5);
  assert.strictEqual(r.openOption?.creditPerContract, 0.56);
});

test("combo stock leg with no quantity or ratio is refused, not guessed", () => {
  const r = parseWheelPositions([
    { symbol: "NVDA", instrument_type: "OPTION", quantity: "5", cost_price: "193.28",
      legs: [
        { symbol: "NVDA", cost: "193.84" },
        { symbol: "NVDA", option_type: "CALL", option_expire_date: "2026-12-11", option_exercise_price: "215", cost: "0.56" },
      ] },
  ], "NVDA");
  assert.ok(r.problems.length > 0);
});

test("the old misread (stock leg first, no option fields) never yields symbol 'NVDA'", () => {
  const r = parseWheelPositions([
    { symbol: "NVDA", instrument_type: "OPTION", quantity: "5", cost_price: "193.28",
      legs: [{ symbol: "NVDA", cost: "193.28" }] },
  ], "NVDA");
  // An OPTION position whose only leg looks like stock is ambiguous: refuse
  // rather than read it as 5 shares (which would let tick() sell 5 naked calls).
  assert.ok(r.problems.length > 0);
});

test("REAL 2026-11-18 COVERED_STOCK position (raw from the failed run's log)", () => {
  const raw = JSON.parse(`[{"currency":"USD","quantity":"5","cost":"96640.00","proportion":"1.0000","legs":[{"symbol":"NVDA","cost":"193.84","proportion":"0.9978","leg_id":"A5JM0683VHRI86B3IQ8TK81FK8","instrument_type":"EQUITY","last_price":"157.72","unrealized_profit_loss":"-18060.00","day_profit_loss":"1140.00","day_realized_profit_loss":"0.00"},{"symbol":"NVDA","cost":"0.56","proportion":"0.0022","leg_id":"A5JM0683VHRI86B3IQ8TK81FK8","instrument_type":"OPTION","last_price":"0.35","unrealized_profit_loss":"105.00","day_profit_loss":"70.00","day_realized_profit_loss":"0.00","option_type":"CALL","option_expire_date":"2026-12-11","option_exercise_price":"215","option_contract_multiplier":"100","option_contract_deliverable":"100","expiration_type":"PM"}],"position_id":"A5JM0683VHRI86B3IQ8TK81FK8","symbol":"NVDA","option_strategy":"COVERED_STOCK","instrument_type":"OPTION","cost_price":"193.28","last_price":"157.37","market_value":"78685.00","unrealized_profit_loss":"-17955.00","unrealized_profit_loss_rate":"-0.1858","day_profit_loss":"1210.00","day_realized_profit_loss":"0.00"}]`) as Position[];
  const r = parseWheelPositions([...raw, spyCall], "NVDA");
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.shares, 500);
  assert.strictEqual(r.costBasis, 193.84);
  assert.strictEqual(r.openOption?.optionSymbol, "NVDA261211C00215000");
  assert.strictEqual(r.openOption?.contracts, 5);
  assert.strictEqual(r.openOption?.creditPerContract, 0.56);
  // A cost that doesn't add up is refused.
  const bad = JSON.parse(JSON.stringify(raw));
  bad[0].cost = "50000.00";
  assert.ok(parseWheelPositions(bad, "NVDA").problems.length > 0);
});

test("nothing held", () => {
  const r = parseWheelPositions([spyCall], "NVDA");
  assert.deepStrictEqual(r, { shares: 0, costBasis: null, openOption: null, problems: [] });
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
