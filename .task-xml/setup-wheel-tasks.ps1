# One-time setup — MUST be run from an ELEVATED PowerShell (Run as
# Administrator). Registering/enabling S4U-principal scheduled tasks needs
# admin rights; this was confirmed live (2026-09-08) — a non-elevated
# attempt to create or enable any of these fails with "Access is denied,"
# same as the sibling webull-agent project's original setup required.
#
# Registers WebullWheelAgent (6:25am Pacific weekdays) and
# WebullWheelDailyReview (1:20pm Pacific weekdays), both S4U so they run
# unattended with no interactive logon required. Also RE-ENABLES the
# sibling project's WebullPreventLidSleep (5:45am)/WebullRestoreLidSleep
# (1:30pm) tasks, which are currently Disabled (left over from when the
# stock agent moved off local scheduling to GitHub Actions) — their window
# fully covers this project's 6:20am-1:25pm Pacific trading window, so
# re-enabling them (rather than creating a second, possibly-conflicting
# pair of power-setting tasks) is what keeps the laptop awake for
# WebullWheelAgent's poll loop and WebullWheelDailyReview's after-close run.
#
# Run this only after the build order's step 4 (a manual, hand-triggered
# live cycle during market hours) has been verified — see CLAUDE.md.
# Registering these tasks is what makes the agent start placing real
# (paper) orders unattended.

schtasks /Change /TN "WebullPreventLidSleep" /Enable
schtasks /Change /TN "WebullRestoreLidSleep" /Enable

$dir = "C:\Users\pedra\projects\webull-options-agent\.task-xml"

schtasks /Create /TN "WebullWheelAgent" /XML "$dir\wheel-agent.xml" /F
schtasks /Create /TN "WebullWheelDailyReview" /XML "$dir\wheel-review.xml" /F

Write-Output "--- verifying ---"
foreach ($t in "WebullPreventLidSleep", "WebullRestoreLidSleep", "WebullWheelAgent", "WebullWheelDailyReview") {
    $task = Get-ScheduledTask -TaskName $t
    $triggers = $task.Triggers | ForEach-Object { $_.StartBoundary }
    "$t -> State=$($task.State) LogonType=$($task.Principal.LogonType) RunLevel=$($task.Principal.RunLevel) Triggers=$($triggers -join ', ')"
}
