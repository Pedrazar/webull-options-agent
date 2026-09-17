/**
 * One-shot entry point for GitHub Actions — invoked fresh on a 15-minute
 * cron (see .github/workflows/wheel-agent.yml), unlike main.ts's long-lived
 * poll loop (built for local Windows Task Scheduler). Each invocation: check
 * whether the market is actually open right now, and if so, run exactly one
 * tick() and exit. State persists across these ephemeral runs only because
 * wheel-state.json/wheel-trades.jsonl are git-committed after each run —
 * see the workflow file.
 *
 * Deliberately does NOT swallow tick() errors the way main.ts's loop does
 * (that loop retries in-process 15 minutes later; here, the next attempt is
 * a whole new Actions run anyway, so letting a genuine error exit non-zero
 * surfaces it in the Actions UI/notifications instead of failing silently).
 */

import "dotenv/config";
import { WebullClient } from "./webullClient";
import { tick } from "./main";
import { isMarketOpenNow } from "./marketHours";

async function main() {
  if (!isMarketOpenNow(new Date())) {
    console.log("[tickOnce] market not open right now — nothing to do, exiting");
    return;
  }

  const baseUrl = process.env.WEBULL_BASE_URL ?? "https://api.sandbox.webull.com";
  const accountId = process.env.WEBULL_SANDBOX_ACCOUNT_ID!;
  if (!accountId) {
    throw new Error("WEBULL_SANDBOX_ACCOUNT_ID must be set — refusing to guess an account.");
  }

  const client = new WebullClient({
    appKey: process.env.WEBULL_APP_KEY!,
    appSecret: process.env.WEBULL_APP_SECRET!,
    baseUrl,
    host: new URL(baseUrl).host,
  });

  await tick(client, accountId);
}

main();
