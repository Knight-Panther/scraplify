[CmdletBinding()]
param(
    [string]$Database = 'scraplify',
    [string]$Container = 'scraplify-postgres-1',
    [string]$DbUser = 'scraplify',
    # How many of the newest backups of this database to keep; older ones are deleted.
    [ValidateRange(1, 1000)]
    [int]$RetentionCount = 14,
    # Also write everything this run prints to logs/backup-db-<date>.log. Set by
    # the scheduled task (register-backup-schedule.ps1), since Task Scheduler
    # keeps no output of its own.
    [switch]$LogToFile
)

# Takes a compressed, restorable backup of one local database (Phase 7A, stage
# 7-4). Before this, the crawled corpus had no backup at all - and it is not
# reproducible: closed/expired history, human review decisions and merge
# audit trails exist only in this database.
#
# pg_dump runs INSIDE the Compose container and writes there, then the file is
# copied out with `docker cp`. Streaming the dump through a PowerShell pipe
# instead would corrupt it: Windows PowerShell 5.1 treats native output as
# text. The archive is validated with `pg_restore --list` before it counts as a
# backup, so a truncated dump fails loudly here rather than at restore time.
$ErrorActionPreference = 'Stop'

$repositoryRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    throw 'Run this script from inside the scraplify Git repository.'
}
$repositoryRoot = $repositoryRoot.Trim()

if ($LogToFile) {
    $logDirectory = Join-Path $repositoryRoot 'logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Start-Transcript -Append -Path (Join-Path $logDirectory ('backup-db-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))) | Out-Null
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'docker is not on PATH. Start Docker Desktop (the database runs in its Compose container) and retry.'
}
$running = docker inspect --format '{{.State.Running}}' $Container 2>$null
if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
    throw "Container '$Container' is not running. Start it with 'docker compose up -d postgres' and retry - refusing to report a backup that did not happen."
}

function Invoke-Checked([string]$Description, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed (exit code $LASTEXITCODE)."
    }
}

$backupDirectory = Join-Path $repositoryRoot 'backups'
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$fileName = "$Database-$stamp.dump"
$containerPath = "/tmp/$fileName"
$hostPath = Join-Path $backupDirectory $fileName

try {
    Invoke-Checked 'pg_dump' { docker exec $Container pg_dump -U $DbUser -d $Database -Fc -f $containerPath }
    Invoke-Checked 'Archive validation (pg_restore --list)' { docker exec $Container pg_restore --list $containerPath | Out-Null }
    Invoke-Checked 'Copying the backup out of the container' { docker cp "${Container}:$containerPath" $hostPath }
} finally {
    docker exec $Container rm -f $containerPath 2>$null | Out-Null
}

$size = (Get-Item -LiteralPath $hostPath).Length
if ($size -le 0) {
    throw "Backup file $hostPath is empty."
}
Write-Host ("Backed up '{0}' to {1} ({2:N1} MB)." -f $Database, $hostPath, ($size / 1MB))

$stale = Get-ChildItem -LiteralPath $backupDirectory -Filter "$Database-*.dump" |
    Sort-Object Name -Descending |
    Select-Object -Skip $RetentionCount
foreach ($file in $stale) {
    Remove-Item -LiteralPath $file.FullName
    Write-Host "Removed old backup $($file.Name) (keeping the newest $RetentionCount)."
}
