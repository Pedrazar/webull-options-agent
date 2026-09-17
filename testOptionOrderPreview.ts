/**
 * Step 3 of the build order — confirms the option order PREVIEW endpoint
 * accepts the built single-leg SELL_TO_OPEN payload without error. Safe to
 * run freely: preview only, never places anything.
 *
 * Depends on testOptionChain.ts having already shown that real contracts
 * come back for the symbol — this pulls one live so the strike/expiration
 * used are guaranteed valid, not made up.
 * Run with: npx tsx testOptionOrderPreview.ts
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import { getOptionChain, previewOptionOrder, getOptionSnapshot } from "./optionsClient";

function isoDateDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;
  const symbol = process.env.WHEEL_SYMBOL ?? "NVDA";

  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const puts = await getOptionChain(client, {
    underlyingSymbol: symbol,
    optionType: "PUT",
    startDate: isoDateDaysFromNow(14),
    endDate: isoDateDaysFromNow(28),
  });

  if (puts.length === 0) {
    console.error("No PUT contracts returned for", symbol, "- run testOptionChain.ts first to diagnose.");
    process.exit(1);
  }

  const contract = puts[Math.floor(puts.length / 2)]; // pick something mid-chain, not necessarily the real 10%-OTM pick — this is just a payload-shape smoke test
  const strike = parseFloat(contract.strike_price);
  console.log(`Using contract: ${contract.symbol} strike=${strike} exp=${contract.expiration_date}`);

  const snap = await getOptionSnapshot(client, [contract.symbol]);
  const bid = snap[0]?.bid ? parseFloat(snap[0].bid) : 0.5;
  console.log(`Quoted bid: ${bid}`);

  console.log("\n=== POST /openapi/trade/option/order/preview (v3, category=US_OPTION) ===");
  try {
    const result = await previewOptionOrder(client, accountId, {
      underlyingSymbol: symbol,
      optionSymbol: contract.symbol,
      side: "SELL",
      quantity: 1, // preview only — always 1 regardless of WHEEL_CONTRACTS, this is a shape smoke test not a real sizing check
      optionType: "PUT",
      strikePrice: strike,
      expirationDate: contract.expiration_date,
      limitPrice: bid > 0 ? bid : 0.5,
      positionIntent: "SELL_TO_OPEN",
    });
    console.log("SUCCESS:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("FAILED:", err);
    console.log("\nDiagnosis:");
    console.log("- 400 mentioning a specific field -> the order body shape needs adjusting, check the error message against optionsClient.ts's buildSingleLegOrder()");
    console.log("- 401/403 -> the category header or v3 version header is missing/wrong for this endpoint");
    console.log("- error about account type/permissions -> this sandbox account may not have options trading enabled; check the Webull developer portal");
  }
}

main();
