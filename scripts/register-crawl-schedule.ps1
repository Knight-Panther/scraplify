[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('jobs-ge', 'hr-ge')]
    [string]$Source,

    # Both sources default to 24h, and neither default is the 30-60 minute row
    # in concept docs/scraplify-concept.md section 19.2 - that row is for
    # lightweight discovery-only polling, which these crawls do not do: both
    # refetch every discovered listing's detail page every run, which is
    # section 19.2's "Complete source reconciliation" / "hr.ge full index
    # reconciliation" rows instead.
    #
    # Measured runtimes (docs/STATUS.md):
    #   jobs.ge - ~5,647 listings at jobsGePolicy's 5s crawl-delay and
    #             maxConcurrency 1 is >= 7h50m of fetches alone per run
    #             (adversarial review, 2026-09-05, round 8).
    #   hr.ge   - ~3.7h for a full-coverage run over 3,354 listings
    #             (2026-09-15, 04:25 -> 08:05 UTC).
    # 0 means "use the source's default" below.
    [int]$IntervalMinutes = 0
)

# Registers (or re-registers) a Windows Task Scheduler job that runs one
# source's crawl on a recurring cadence, per concept section 19.1's "Windows
# Task Scheduler starts the worker." NOT run automatically by anything in
# this repo - a human runs this deliberately, once ready to let the crawler make
# real, unsupervised, recurring requests against the live site.
#
# Replaces the earlier jobs.ge-only register-jobs-ge-schedule.ps1 (Phase 7A,
# stage 7-1); that one was never actually registered on this machine, so no
# existing task depends on the old name or path.
$ErrorActionPreference = 'Stop'

$defaults = @{
    'jobs-ge' = @{ IntervalMinutes = 1440; RuntimeMinutes = 480; Description = 'roughly 8-9 hours' }
    'hr-ge'   = @{ IntervalMinutes = 1440; RuntimeMinutes = 225; Description = 'roughly 3-4 hours' }
}
$sourceDefaults = $defaults[$Source]
if ($IntervalMinutes -eq 0) {
    $IntervalMinutes = $sourceDefaults.IntervalMinutes
}
if ($IntervalMinutes -lt 1) {
    throw 'IntervalMinutes must be a positive integer.'
}

$repositoryRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    throw 'Run this script from inside the scraplify Git repository.'
}
$repositoryRoot = $repositoryRoot.Trim()

$wrapperScript = Join-Path $repositoryRoot 'scripts/run-crawl.ps1'
if (-not (Test-Path -LiteralPath $wrapperScript -PathType Leaf)) {
    throw "Expected wrapper script not found: $wrapperScript"
}

foreach ($entryPoint in @("dist/cli/run-$Source-crawl.js", 'dist/cli/run-dedupe.js', 'dist/cli/backfill-taxonomy.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $entryPoint) -PathType Leaf)) {
        throw "Build output not found: $entryPoint. Run 'npm run build' before registering the schedule, so the first scheduled fire doesn't just fail."
    }
}

$envFile = Join-Path $repositoryRoot '.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Expected $envFile (see README.md's Database section). Create it before registering the schedule."
}

# Resolved HERE (this script always runs interactively, in a profile-loaded
# shell where fnm's own PATH hook has already run), not inside the wrapper
# script Task Scheduler actually launches - that runs under `-NoProfile`,
# so fnm's hook never fires for it, and a bare `node` call there would fail
# to resolve on a machine where Node is only ever put on PATH by that hook
# (adversarial review, 2026-09-05, round 8's originally-deferred P2).
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Could not resolve 'node' on PATH in this shell. Open a fresh shell (so fnm's PATH hook runs) and try again."
}
$nodePath = $nodeCommand.Source

$taskName = "Scraplify - $Source crawl"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapperScript`" -Source $Source -NodePath `"$nodePath`"" `
    -WorkingDirectory $repositoryRoot

# No -RepetitionDuration: omitting it repeats indefinitely. The earlier
# `[TimeSpan]::MaxValue` serializes to P99999999DT23H59M59S, which Task
# Scheduler on Windows 11 rejects as out of range (found 2026-09-16, the first
# time this script was actually run).
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -DontStopOnIdleEnd

# -ErrorAction Stop explicitly: Register-ScheduledTask reports a rejected task
# as a non-terminating CIM error, which the script-wide preference did not turn
# into a stop, so a failed registration went on to print "registered" below.
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null

# Trust the registry of tasks, not the absence of an error.
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $registered) {
    throw "Scheduled task '$taskName' was not found after registering it."
}
$repetition = $registered.Triggers[0].Repetition.Interval
if ($repetition -ne ('PT{0}M' -f $IntervalMinutes) -and $repetition -ne [System.Xml.XmlConvert]::ToString((New-TimeSpan -Minutes $IntervalMinutes))) {
    throw "Scheduled task '$taskName' registered with repetition interval '$repetition', expected every $IntervalMinutes minute(s)."
}

Write-Host "Scheduled task '$taskName' registered: fires every $IntervalMinutes minute(s), starting in about 1 minute."
Write-Host "Resolved node to: $nodePath (baked into the scheduled action, so unattended runs don't depend on fnm's PATH hook firing)."
Write-Host "Each run is a full $Source crawl (discovery + every listing detail) followed by dedupe and taxonomy passes, measured at $($sourceDefaults.Description) end to end - not a quick poll."
if ($IntervalMinutes -lt $sourceDefaults.RuntimeMinutes) {
    Write-Warning "IntervalMinutes ($IntervalMinutes) is under the measured runtime. -MultipleInstances IgnoreNew means overlapping triggers are silently dropped rather than queued, so most firings will simply no-op while the previous run is still going."
}
Write-Host 'Registered to run only when this user is logged on (no stored credentials) - the default for an interactive Register-ScheduledTask call.'
Write-Host "Logs land in $(Join-Path $repositoryRoot 'logs')\$Source-crawl-<date>.log."
Write-Host "Inspect or manage it in Task Scheduler (taskschd.msc) under Task Scheduler Library, or remove it with:"
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
