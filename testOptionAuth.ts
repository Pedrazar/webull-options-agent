/**
 * Step 1 of the build order (see CLAUDE.md) — proves the sandbox account_id
 * from .env actually works for the v3 account/balance endpoints before
 * anything option-specific is trusted. Run with: npx tsx testOptionAuth.ts
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import { getAccountList, getAccountBalance } from "./optionsClient";

async function main() {
  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;

  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  console.log("=== GET /trading/accounts/list (v3) ===");
  try {
    const accounts = await getAccountList(client);
    console.log("SUCCESS:", JSON.stringify(accounts, null, 2));
  } catch (err) {
    console.error("FAILED:", err);
  }

  console.log("\n=== GET /trading/assets/balances/get (v3), account_id =", accountId, "===");
  try {
    const balance = await getAccountBalance(client, accountId);
    console.log("SUCCESS:", JSON.stringify(balance, null, 2));
  } catch (err) {
    console.error("FAILED:", err);
    console.log("\nDiagnosis:");
    console.log("- 401/403 with a signature/auth error -> the v3 header or path is wrong for this call");
    console.log("- 404 -> the endpoint path itself is wrong, cross-check against the API Reference");
    console.log("- A clean JSON error body mentioning account type -> this sandbox account may not have options trading enabled");
  }
}

main();
