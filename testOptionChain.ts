/**
 * Step 2 of the build order — confirms the option-chain endpoint returns
 * real NVDA PUT/CALL contracts in a 14-28 day window, and that the option
 * snapshot endpoint returns a live quote for one of them.
 * Run with: npx tsx testOptionChain.ts
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import { getOptionChain, getOptionSnapshot } from "./optionsClient";

function isoDateDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const symbol = process.env.WHEEL_SYMBOL ?? "NVDA";

  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  const startDate = isoDateDaysFromNow(14);
  const endDate = isoDateDaysFromNow(28);

  console.log(`=== GET option chain: ${symbol} PUT, ${startDate}..${endDate} ===`);
  try {
    const puts = await getOptionChain(client, {
      underlyingSymbol: symbol,
      optionType: "PUT",
      startDate,
      endDate,
    });
    console.log(`SUCCESS: ${puts.length} contract(s) returned`);
    console.log(JSON.stringify(puts.slice(0, 5), null, 2));

    if (puts.length > 0) {
      const first = puts[0];
      console.log(`\n=== GET option snapshot for ${first.symbol} ===`);
      const snap = await getOptionSnapshot(client, [first.symbol]);
      console.log("SUCCESS:", JSON.stringify(snap, null, 2));
    } else {
      console.log("No contracts returned — can't test the snapshot endpoint against a real symbol.");
    }
  } catch (err) {
    console.error("FAILED:", err);
    console.log("\nDiagnosis:");
    console.log("- 404 -> chain endpoint path/query params are wrong, cross-check API Reference");
    console.log("- Empty array with 200 OK -> query params may be too narrow, or this sandbox has no option chain data for NVDA");
  }
}

main();
