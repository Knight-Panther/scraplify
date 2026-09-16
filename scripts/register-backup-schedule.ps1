[CmdletBinding()]
param(
    # Local time of day the daily backup runs. Midday rather than night: the
    # task runs only while this user is logged on, and -StartWhenAvailable
    # catches up a missed time at the next logon anyway.
    [string]$At = '13:00'
)

# Registers (or re-registers) a daily Windows Task Scheduler job that runs
# scripts/backup-db.ps1 against the real corpus (Phase 7A follow-up). Unlike
# the crawl schedules this makes no external requests: pg_dump only reads the
# local database. Output goes to logs/backup-db-<date>.log; a failed backup
# shows as a non-zero Last Run Result in Task Scheduler.
$ErrorActionPreference = 'Stop'

$repositoryRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    throw 'Run this script from inside the scraplify Git repository.'
}
$repositoryRoot = $repositoryRoot.Trim()

$backupScript = Join-Path $repositoryRoot 'scripts/backup-db.ps1'
if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) {
    throw "Expected backup script not found: $backupScript"
}

$time = [datetime]::ParseExact($At, 'HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
$taskName = 'Scraplify - database backup'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`" -LogToFile" `
    -WorkingDirectory $repositoryRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $time
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable

# -ErrorAction Stop and the read-back below: a rejected registration is a
# non-terminating CIM error, which let the crawl registration script print
# "registered" for tasks that did not exist (found 2026-09-16).
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null

$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $registered) {
    throw "Scheduled task '$taskName' was not found after registering it."
}
$info = $registered | Get-ScheduledTaskInfo

Write-Host "Scheduled task '$taskName' registered: daily at $At, next run $($info.NextRunTime)."
Write-Host "Backups land in $(Join-Path $repositoryRoot 'backups') (newest 14 kept); logs in logs\backup-db-<date>.log."
Write-Host "Remove it with: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
