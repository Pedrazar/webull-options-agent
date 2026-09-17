/**
 * Build order step 4 — a manually-triggered single tick of the real state
 * machine (main.ts's tick()), run once by hand and inspected before trusting
 * the unattended scheduled loop. Unlike testOptionOrderPreview.ts (a preview
 * only), this calls the exact same code path main.ts's loop uses, including
 * a REAL order placement if every guard passes — run it deliberately, not
 * as a routine smoke test.
 * Run with: npx tsx verifyOneCycle.ts
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import { tick } from "./main";

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;
  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  console.log("=== single manual tick ===");
  await tick(client, accountId);
  console.log("=== tick complete — inspect wheel-trades.jsonl / wheel-state.json above ===");
}

main();
