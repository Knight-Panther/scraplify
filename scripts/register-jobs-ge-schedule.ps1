[CmdletBinding()]
param(
    # NOT the 30-60 minute row in concept docs/scraplify-concept.md §19.2 —
    # that row is for lightweight discovery-only polling, which this crawl
    # does not do: runJobsGeCrawl refetches every discovered listing's detail
    # page every run (fullCoverage: true), which is §19.2's "Complete source
    # reconciliation" row instead ("Nightly or weekly"). Measured basis
    # (adversarial review, 2026-09-05, round 8): ~5,647 listings + ~21
    # discovery/probe fetches, at jobsGePolicy's 5s crawl-delay and
    # maxConcurrency 1 (src/policies/jobs-ge.ts), is >= 7h50m of fetches
    # alone per run — a 60-minute cadence would just run back-to-back
    # continuously while claiming to be hourly. 1440 (24h) is the
    # conservative end of "nightly." True hourly-ish discovery is what
    # concept §10.1's incremental discovery would unlock — deliberately not
    # implemented yet (docs/STATUS.md), since jobs.ge's corpus is small
    # enough to fully re-walk on this slower cadence instead.
    [int]$IntervalMinutes = 1440
)

# Registers (or re-registers) a Windows Task Scheduler job that runs the
# jobs.ge crawl on a recurring cadence, per concept §19.1's "Windows Task
# Scheduler starts the worker." NOT run automatically by anything in this
# repo — a human runs this deliberately, once ready to let the crawler make
# real, unsupervised, recurring requests against the live site.
$ErrorActionPreference = 'Stop'

if ($IntervalMinutes -lt 1) {
    throw 'IntervalMinutes must be a positive integer.'
}

$repositoryRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    throw 'Run this script from inside the scraplify Git repository.'
}
$repositoryRoot = $repositoryRoot.Trim()

$wrapperScript = Join-Path $repositoryRoot 'scripts/run-jobs-ge-crawl.ps1'
if (-not (Test-Path -LiteralPath $wrapperScript -PathType Leaf)) {
    throw "Expected wrapper script not found: $wrapperScript"
}

$buildOutput = Join-Path $repositoryRoot 'dist/cli/run-jobs-ge-crawl.js'
if (-not (Test-Path -LiteralPath $buildOutput -PathType Leaf)) {
    throw "Build output not found: $buildOutput. Run 'npm run build' before registering the schedule, so the first scheduled fire doesn't just fail."
}

$envFile = Join-Path $repositoryRoot '.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Expected $envFile (see README.md's Database section). Create it before registering the schedule."
}

$taskName = 'Scraplify - jobs.ge crawl'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapperScript`"" `
    -WorkingDirectory $repositoryRoot

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -DontStopOnIdleEnd

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Scheduled task '$taskName' registered: fires every $IntervalMinutes minute(s), starting in about 1 minute."
Write-Host 'Each run is a full jobs.ge crawl (discovery + every listing detail), measured at roughly 8-9 hours end to end — not a quick poll.'
if ($IntervalMinutes -lt 480) {
    Write-Warning "IntervalMinutes ($IntervalMinutes) is well under the ~8-9 hour measured runtime. -MultipleInstances IgnoreNew means overlapping triggers are silently dropped rather than queued, so most firings will simply no-op while the previous run is still going."
}
Write-Host 'Registered to run only when this user is logged on (no stored credentials) — the default for an interactive Register-ScheduledTask call.'
Write-Host "Logs land in $(Join-Path $repositoryRoot 'logs')\jobs-ge-crawl-<date>.log."
Write-Host "Inspect or manage it in Task Scheduler (taskschd.msc) under Task Scheduler Library, or remove it with:"
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
