[CmdletBinding()]
param(
    [string]$Database = 'scraplify',
    [string]$Container = 'scraplify-postgres-1',
    [string]$DbUser = 'scraplify',
    # A specific backup to drill; defaults to the newest backups/<Database>-*.dump.
    [string]$BackupPath
)

# Restore drill (Phase 7A, stage 7-4; concept Phase 7 exit gate: "restoration/
# rollback is practiced"). Restores a backup into a throwaway database, compares
# per-table row counts against the database it came from, then drops the
# throwaway copy. Exits 1 if the restore fails or any count differs.
#
# Never touches the source database: the drill target name is fixed and
# distinct, and the script refuses to run if they would coincide. Counts can
# legitimately differ if the source was written to after the backup was taken
# (a crawl running meanwhile), so run it right after a backup, with no crawl
# in progress.
$ErrorActionPreference = 'Stop'

$drillDatabase = "${Database}_restore_drill"
if ($drillDatabase -eq $Database) {
    throw 'Drill database name collides with the source database.'
}

$repositoryRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    throw 'Run this script from inside the scraplify Git repository.'
}
$repositoryRoot = $repositoryRoot.Trim()

if (-not $BackupPath) {
    $newest = Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'backups') -Filter "$Database-*.dump" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $newest) {
        throw "No backups/$Database-*.dump found. Run scripts/backup-db.ps1 first."
    }
    $BackupPath = $newest.FullName
}
if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
    throw "Backup not found: $BackupPath"
}

$running = docker inspect --format '{{.State.Running}}' $Container 2>$null
if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
    throw "Container '$Container' is not running. Start it with 'docker compose up -d postgres' and retry."
}

function Invoke-Checked([string]$Description, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed (exit code $LASTEXITCODE)."
    }
}

# Exact row counts for every table in the public schema, as "table|count" lines.
function Get-RowCounts([string]$TargetDatabase) {
    $query = @"
select format('%s|%s', table_name,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text)
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by table_name
"@
    $lines = docker exec $Container psql -U $DbUser -d $TargetDatabase -At -v ON_ERROR_STOP=1 -c $query
    if ($LASTEXITCODE -ne 0) {
        throw "Counting rows in $TargetDatabase failed (exit code $LASTEXITCODE)."
    }
    $counts = [ordered]@{}
    foreach ($line in $lines) {
        $name, $value = $line -split '\|', 2
        $counts[$name] = [long]$value
    }
    return $counts
}

$containerPath = '/tmp/restore-drill.dump'
$started = Get-Date
$mismatches = 0
try {
    Invoke-Checked 'Copying the backup into the container' { docker cp $BackupPath "${Container}:$containerPath" }
    Invoke-Checked 'Dropping a leftover drill database' { docker exec $Container dropdb -U $DbUser --if-exists $drillDatabase }
    Invoke-Checked 'Creating the drill database' { docker exec $Container createdb -U $DbUser $drillDatabase }
    # --exit-on-error: a partial restore must fail the drill, not pass with missing tables.
    Invoke-Checked 'pg_restore' { docker exec $Container pg_restore -U $DbUser -d $drillDatabase --no-owner --exit-on-error $containerPath }
    $restoreSeconds = [int]((Get-Date) - $started).TotalSeconds

    $source = Get-RowCounts $Database
    $restored = Get-RowCounts $drillDatabase

    Write-Host "Restored $(Split-Path -Leaf $BackupPath) into $drillDatabase in ${restoreSeconds}s. Row counts (source -> restored):"
    foreach ($table in ($source.Keys + $restored.Keys | Sort-Object -Unique)) {
        $a = if ($source.Contains($table)) { $source[$table] } else { 'missing' }
        $b = if ($restored.Contains($table)) { $restored[$table] } else { 'missing' }
        $mark = if ("$a" -eq "$b") { 'ok      ' } else { $mismatches++; 'MISMATCH' }
        Write-Host ("  {0} {1,-40} {2,10} -> {3,10}" -f $mark, $table, $a, $b)
    }
} finally {
    docker exec $Container dropdb -U $DbUser --if-exists $drillDatabase 2>$null | Out-Null
    docker exec $Container rm -f $containerPath 2>$null | Out-Null
}

if ($mismatches -gt 0) {
    Write-Error "$mismatches table(s) differ. If nothing wrote to '$Database' since the backup, the backup is not trustworthy."
    exit 1
}
Write-Host "Restore drill passed: every table's row count matches. The drill database has been dropped."
