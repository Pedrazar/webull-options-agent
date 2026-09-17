$ErrorActionPreference = "Stop"
Set-Location "C:\Users\pedra\projects\webull-options-agent"

Add-Type -AssemblyName System.Windows.Forms
$powerStatus = [System.Windows.Forms.SystemInformation]::PowerStatus
$batteryPct = [int]($powerStatus.BatteryLifePercent * 100)
if ($powerStatus.PowerLineStatus -eq "Offline" -and $batteryPct -lt 20) {
    Write-Output "[power] on battery at $batteryPct percent, below the 20 percent threshold - skipping this run"
    exit 0
}

# Without this, PowerShell decodes claude.exe's UTF-8 stdout (em dashes,
# curly quotes, etc.) through the legacy console codepage instead, mangling
# any non-ASCII character — same fix as the sibling webull-agent project's
# run-daily-review.ps1 (confirmed live there: em dashes came out as "ΓÇö").
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# NOTE: this agent is Read/Glob/Grep only, deliberately with NO Write access.
# Headless (-p) mode has no one to approve a Write permission prompt, so an
# agent that tries to use the Write tool here just stalls describing what it
# would do instead of doing it. Instead it's told to output the full report
# as its plain response text, and THIS SCRIPT saves that text to disk via
# PowerShell's own file write, sidestepping the tool-permission system.
$prompt = @'
You are reviewing today's activity for an automated NVDA options wheel
strategy running against Webull's sandbox (paper trading) API. Your job is
pure analysis and reporting. You must NOT modify any .ts file (main.ts,
optionsClient.ts, wheelState.ts, etc.) — only read data files. You have no
Write access in this session; do not attempt to use a Write tool. Instead,
output the entire report as the text of your reply.

Working directory: C:\Users\pedra\projects\webull-options-agent (already your cwd)

Strategy recap: sell a cash-secured PUT ~10% below NVDA's price (2-4 weeks
out) to collect premium; if assigned, hold the shares and sell a covered
CALL ~10% above cost basis (2-4 weeks out); if called away, go back to
selling puts. Any open short option is closed early at 50% of the credit
captured. Hard rules: never sell a put without enough cash to cover
assignment, never sell a call below cost basis.

Files to read:
- wheel-trades.jsonl — one JSON object per line, append-only event log.
  Event types:
  - put_sold: {symbol, optionSymbol, strike, expiration, contracts,
    creditPerContract, totalCredit, clientOrderId, underlyingPrice,
    targetStrike} — underlyingPrice is NVDA's price when the decision was
    made; targetStrike is the exact 10%-OTM strike computed from it before
    rounding to the nearest available strike at or below it (the `strike`
    field is that rounded, actually-traded value). If underlyingPrice or
    targetStrike are missing, this event predates when that logging was
    added (2026-09-09) — don't treat their absence as an anomaly.
  - call_sold: {symbol, optionSymbol, strike, expiration, contracts,
    creditPerContract, totalCredit, costBasis, clientOrderId, targetStrike}
    — targetStrike is costBasis * 1.10 before rounding to the nearest
    available strike at or above it. Same "missing = predates the field"
    caveat as put_sold.
  - put_closed_early / call_closed_early: {symbol, optionSymbol,
    creditReceived, debitPaid, realizedPnl, pctOfCreditCaptured} — an early
    close at the 50% profit-take rule.
  - put_expired_worthless / call_expired_worthless: {symbol, optionSymbol,
    creditReceived} — the full premium was kept, no assignment.
  - put_assigned: {symbol, optionSymbol, strike, contracts, shares,
    costBasis} — the put was exercised, shares were bought, stage moves to
    selling covered calls.
  - call_assigned: {symbol, optionSymbol, strike, shares, costBasis,
    saleProceeds, capitalGain, totalPremiumThisCycle} — shares were called
    away, stage moves back to selling puts. (Field name "call_assigned"
    describes the shares being called away, not a call being purchased.)
  - guard_rejected: {symbol, stage, reason (
    "insufficient_cash"|"strike_below_cost_basis"|"no_suitable_contract"|
    "preview_failed"), detail} — a hard safety rule blocked an action this
    tick. "insufficient_cash" means the account's buying power couldn't
    cover cash-securing a put at the target strike — call this out
    explicitly, since it means the strategy is idle despite being "in
    stage PUT" until either buying power grows or contracts/strike drop.
- wheel-state.json — current snapshot: stage (PUT or CALL), openOption (if
  any: optionSymbol, strike, expiration, contracts, creditPerContract),
  shares, costBasis, cumulativePremium (running total across ALL cycles,
  the number that matters most for "is this strategy working").
- wheel-agent-run-<today's date>_*.log — today's run log. While an option
  position is open, every 15-minute tick logs a `[profit-take]` line (added
  2026-09-11): either `ask=$X vs threshold=$Y (...) -> CLOSE` or `-> hold`,
  or `no ask quote available this tick, skipping check` / `no credit basis
  available this tick, skipping check` if the check couldn't run that tick.
  This is what makes "no closed_early event today" distinguishable from "the
  check silently failed" — if a `[profit-take]` line is absent for some
  ticks, or repeatedly shows the "skipping check" variants, call that out
  explicitly, since it means the 50%-rule wasn't actually being evaluated
  during that stretch even though nothing looked wrong from the trade log
  alone.

Task:
1. Filter wheel-trades.jsonl to today's date (compare the `ts` field's date
   portion to today's date).
2. State the current stage plainly at the top (from wheel-state.json): are
   we holding a short put, short call, or shares, or a mix and what's the
   expiration / days-to-expiry on any open option.
3. Report today's premium collected (sum of totalCredit from any put_sold/
   call_sold today, plus realizedPnl from any closed-early events today),
   and the cumulativePremium running total (all-time, from wheel-state.json)
   — call this out as the headline number.
4. If any guard_rejected events exist today, list each with its reason and
   detail — these represent the strategy being blocked by its own safety
   rules, which is a normal and expected outcome, not a bug, but worth
   surfacing plainly (especially "insufficient_cash", which likely means
   the account doesn't have enough buying power to cash-secure a put at
   NVDA's current price and contract count).
5. If a put_assigned or call_assigned event happened today, call it out
   as the headline event of the day — a stage transition is the most
   consequential thing that can happen in this strategy.
6. Format your reply as a full markdown report: current stage/position
   summary, today's premium + cumulative total, a "What happened today"
   narrative section (or "No activity today" if wheel-trades.jsonl has no
   events for today), a "Blocked by safety rules" section (only if any
   guard_rejected events exist today — omit entirely otherwise), and a
   "Cycle history" one-line-per-cycle summary if this isn't the strategy's
   first cycle (infer cycle boundaries from put_assigned/call_assigned
   pairs). Output ONLY the report — no preamble, no closing remarks.
7. If wheel-trades.jsonl doesn't exist yet or has no entries at all, report
   that the strategy hasn't started trading yet and state the current
   wheel-state.json stage/config as the only available information.

Keep the report factual and specific to today's numbers — this is a data
summary for a human to act on, not a persuasive pitch.
'@

if (-not (Test-Path "daily-reviews")) {
    New-Item -ItemType Directory -Path "daily-reviews" | Out-Null
}

$date = Get-Date -Format "yyyy-MM-dd"
$runStamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$reportFile = "daily-reviews\$date.md"
$logFile = "daily-review-run-$runStamp.log"

$output = & "C:\Users\pedra\.local\bin\claude.exe" -p $prompt --allowedTools "Read,Glob,Grep" --model claude-sonnet-5 2>&1
$output | Out-File -FilePath $logFile -Encoding utf8
$output | Out-File -FilePath $reportFile -Encoding utf8
