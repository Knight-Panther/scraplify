[CmdletBinding()]
param(
    # concept docs/scraplify-concept.md §19.2's starting cadence for jobs.ge
    # discovery is 30-60 minutes; 60 is the conservative end of that range.
    [int]$IntervalMinutes = 60
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
Write-Host 'Registered to run only when this user is logged on (no stored credentials) — the default for an interactive Register-ScheduledTask call.'
Write-Host "Logs land in $(Join-Path $repositoryRoot 'logs')\jobs-ge-crawl-<date>.log."
Write-Host "Inspect or manage it in Task Scheduler (taskschd.msc) under Task Scheduler Library, or remove it with:"
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
