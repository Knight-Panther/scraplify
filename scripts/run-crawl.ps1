[CmdletBinding()]
param(
    # Which board to crawl. Each maps to its own dist/cli/run-<source>-crawl.js.
    [Parameter(Mandatory = $true)]
    [ValidateSet('jobs-ge', 'hr-ge')]
    [string]$Source,

    # Absolute path to node.exe, resolved once by register-crawl-schedule.ps1
    # at registration time (a profile-loaded, interactive shell, where fnm's
    # PATH setup has already run) and passed in here - this wrapper itself
    # runs under Task Scheduler's `-NoProfile`, so fnm's own PATH hook never
    # runs for it, and a bare `node` call would fail to resolve on a machine
    # where Node is only ever put on PATH by that hook (adversarial review,
    # 2026-09-05, round 8's originally-deferred P2). Defaults to the bare
    # command for direct/manual invocation outside Task Scheduler, where the
    # caller's own shell has already resolved `node` onto PATH normally.
    [string]$NodePath = 'node'
)

# Wrapper invoked by the Windows Task Scheduler job (see
# register-crawl-schedule.ps1) rather than calling node directly: Task
# Scheduler does not capture a process's stdout/stderr on its own, and
# concept docs/scraplify-concept.md section 19.1 requires that a failed or skipped
# run never pass silently, so every invocation's output has to land
# somewhere a person can actually find it afterwards.
#
# Replaces the earlier jobs.ge-only run-jobs-ge-crawl.ps1 (Phase 7A, stage
# 7-1): hr.ge had no wrapper at all, so every hr.ge crawl was manual and none
# of them chained dedupe - half of how the 2026-09-15 incident happened.
$ErrorActionPreference = 'Stop'

$repositoryRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    throw 'Run this script from inside the scraplify Git repository.'
}
$repositoryRoot = $repositoryRoot.Trim()

$crawlEntryPoint = "dist/cli/run-$Source-crawl.js"
$dedupeEntryPoint = 'dist/cli/run-dedupe.js'
$taxonomyEntryPoint = 'dist/cli/backfill-taxonomy.js'
foreach ($entryPoint in @($crawlEntryPoint, $dedupeEntryPoint, $taxonomyEntryPoint)) {
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $entryPoint) -PathType Leaf)) {
        throw "Build output not found: $entryPoint. Run 'npm run build' in $repositoryRoot first."
    }
}

$envFile = Join-Path $repositoryRoot '.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Expected $envFile (see README.md's Database section) - refusing to run without it rather than silently using an unconfigured environment."
}

$logDirectory = Join-Path $repositoryRoot 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logFile = Join-Path $logDirectory ('{0}-crawl-{1}.log' -f $Source, (Get-Date -Format 'yyyy-MM-dd'))

# Log retention: each scheduled source writes a new file per day, and the
# daily backup another, so without this logs/ only ever grows. 30 days keeps
# more than enough history to investigate a failed run. Best effort - a file
# that cannot be deleted must never fail the crawl itself.
$logRetentionDays = 30
try {
    Get-ChildItem -LiteralPath $logDirectory -Filter '*.log' -File |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$logRetentionDays) } |
        Remove-Item -ErrorAction SilentlyContinue
} catch {
    # Ignored deliberately; see above.
}

# Node writes UTF-8, and listing titles are Georgian. Windows PowerShell 5.1
# otherwise decodes native output with the console's OEM code page and
# `*>>` appends it as UTF-16 next to Add-Content's ANSI headers, which left the
# earlier jobs.ge wrapper's logs mixed-encoding and Georgian unreadable (found
# 2026-09-16, Phase 7A). Everything below is written as UTF-8 instead.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # No console attached; native output decoding then falls back to the default.
}

function Write-LogLine([string]$Line) {
    $Line | Add-Content -LiteralPath $logFile -Encoding UTF8
}

function Invoke-LoggedNode([string[]]$Arguments) {
    # 'Continue' for the native call only: under 'Stop', Windows PowerShell
    # turns the first stderr line of a 2>&1 redirect into a terminating
    # error, which would abort the wrapper on an ordinary stack trace and
    # skip the dedupe pass and exit-code handling below.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $NodePath @Arguments 2>&1 |
            ForEach-Object { "$_" } |
            Out-File -LiteralPath $logFile -Append -Encoding utf8
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

Push-Location $repositoryRoot
try {
    Write-LogLine "----- $(Get-Date -Format o) $Source crawl -----"
    $exitCode = Invoke-LoggedNode @('--env-file=.env', $crawlEntryPoint)
    Write-LogLine "----- crawl exit code $exitCode -----"

    # Dedupe after every crawl attempt, not only a successful one: a run that
    # ends in failure or a partial sweep can still have written new listings
    # before it stopped, and those need canonicalizing same as any other.
    # Without this, every listing a crawl adds stays invisible outside the raw
    # /listings view (docs/STATUS.md, "Incident: runDedupe had not run since
    # 2026-09-06"). `--auto-link` is what closes that gap: only
    # `confirmed_same` pairs auto-merge, under scorePair's own high-confidence,
    # multi-signal restriction; anything less certain is queued for /review.
    # Concurrent passes from two sources' schedules are serialized by the
    # dedupe advisory lock (src/dedupe/dedupe-lock.ts).
    Write-LogLine "----- $(Get-Date -Format o) dedupe -----"
    $dedupeExitCode = Invoke-LoggedNode @('--env-file=.env', $dedupeEntryPoint, '--auto-link')
    Write-LogLine "----- dedupe exit code $dedupeExitCode -----"

    # Classify after every crawl too: nothing else ever classifies newly
    # crawled listings, so without this every listing a schedule adds stays
    # uncategorized - the same shape as the dedupe gap above (found
    # 2026-09-16). Seeds any new hr.ge category first, then classifies;
    # idempotent, and serialized across schedules by its own advisory lock.
    # Runs for jobs.ge too: it has no category data, so the pass only
    # re-checks hr.ge, cheaply, and a source-specific skip would be one more
    # thing to keep in sync when jobs.ge ever gains categories.
    Write-LogLine "----- $(Get-Date -Format o) taxonomy backfill -----"
    $taxonomyExitCode = Invoke-LoggedNode @('--env-file=.env', $taxonomyEntryPoint)
    Write-LogLine "----- taxonomy backfill exit code $taxonomyExitCode -----"

    # concept section 19.1: a failed or skipped run must never pass
    # silently. A crawl that itself succeeded but left a failed dedupe or
    # classification pass behind is not a clean run either, so it must not
    # exit 0. The crawl's own failure code wins when there are several.
    foreach ($stepExitCode in @($dedupeExitCode, $taxonomyExitCode)) {
        if ($exitCode -eq 0 -and $stepExitCode -ne 0) {
            $exitCode = $stepExitCode
        }
    }
} finally {
    Pop-Location
}

exit $exitCode
